// ── Thermal receipt printer engine ──────────────────────────────────────────
// Prints stream events (subs, gifts, super chats, TikTok gifts, …) as styled
// raster receipts on an 80mm ESC/POS printer (Rongta RP80 class). The
// renderer taps its normalized event pipeline and forwards print jobs here;
// a hidden BrowserWindow (printer-render.html) draws each receipt on a
// 576-dot-wide canvas, Floyd–Steinberg dithers it to 1-bit and packs the
// raster rows. This module wraps the raster in ESC/POS, serializes jobs
// through a queue and spools raw bytes to the Windows printer via a
// winspool RawPrinterHelper (PowerShell Add-Type — no native npm modules).
//
// Feature is gated renderer-side to the broadcaster allowlist; this module
// is inert until it receives a config with a printer name.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

let cfg = { enabled: false, printerName: '', maxPerMinute: 6 };
let queue = [];
let printing = false;
let renderWin = null;
let renderSeq = 0;
let recent = [];            // timestamps of recent prints (rate limit window)
let lastResult = { ok: null, at: 0, error: '' };
let receiptCounter = 0;
let logFn = function () {};
let notifyFn = null;        // paper-state changes → main.js → renderer banner
let paperState = 'unknown'; // 'ok' | 'low' | 'out' | 'offline' | 'unknown'
let paperTimer = null;
let paperWarned = false;    // one FEED ME receipt per low-paper episode

function cfgPath() { return path.join(app.getPath('userData'), 'printer-config.json'); }

function loadConfig() {
  try {
    const d = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    if (d && typeof d === 'object') cfg = Object.assign(cfg, d);
    if (typeof d.receiptCounter === 'number') receiptCounter = d.receiptCounter;
  } catch (e) {}
}

function saveConfig() {
  try {
    fs.writeFileSync(cfgPath(), JSON.stringify(Object.assign({}, cfg, { receiptCounter: receiptCounter })));
  } catch (e) {}
}

function init(opts) {
  if (opts && opts.log) logFn = opts.log;
  if (opts && opts.notify) notifyFn = opts.notify;
  loadConfig();
  startPaperWatch();
}

// ── Paper watch ──────────────────────────────────────────────────────────────
// Best-effort roll monitoring through the Windows driver (Win32_Printer.
// DetectedErrorState: 3 = low paper, 4 = no paper). Receipt-printer drivers
// vary in what they report — when the driver stays silent the state simply
// remains 'ok'/'unknown' and this feature is inert. On the first 'low' of an
// episode we also print one FEED ME receipt so the warning is physical.
function startPaperWatch() {
  if (paperTimer) return;
  paperTimer = setInterval(pollPaper, 90000);
  setTimeout(pollPaper, 6000);
}

function pollPaper() {
  if (!cfg.printerName || !cfg.enabled) { paperState = 'unknown'; return; }
  try {
    const nameEsc = cfg.printerName.replace(/'/g, "''");
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       "Get-CimInstance Win32_Printer -Filter \"Name='" + nameEsc + "'\" | Select-Object DetectedErrorState,PrinterStatus,WorkOffline | ConvertTo-Json -Compress"],
      { windowsHide: true });
    let out = '';
    ps.stdout.on('data', function (d) { out += d.toString(); });
    ps.on('close', function () {
      let next = 'ok';
      try {
        const j = JSON.parse(out.trim() || 'null');
        if (!j) next = 'unknown';
        else if (j.WorkOffline === true) next = 'offline';
        else if (Number(j.DetectedErrorState) === 4) next = 'out';
        else if (Number(j.DetectedErrorState) === 3) next = 'low';
      } catch (e) { next = 'unknown'; }
      const prev = paperState;
      paperState = next;
      if (next !== prev && (next === 'low' || next === 'out' || next === 'offline' || prev === 'low' || prev === 'out' || prev === 'offline')) {
        logFn('paper state: ' + prev + ' -> ' + next);
        try { if (notifyFn) notifyFn(next); } catch (e) {}
      }
      if (next === 'low' && !paperWarned) {
        paperWarned = true;
        enqueue({
          platform: 'sys', banner: 'FEED ME', isTest: true,
          action: 'paper is running low',
          message: 'swap the roll before the next gift bomb'
        });
      }
      if (next === 'ok') paperWarned = false;
    });
    ps.on('error', function () {});
  } catch (e) {}
}

function setConfig(patch) {
  if (patch && typeof patch === 'object') {
    if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled;
    if (typeof patch.printerName === 'string') cfg.printerName = patch.printerName;
    if (typeof patch.maxPerMinute === 'number' && patch.maxPerMinute > 0) cfg.maxPerMinute = patch.maxPerMinute;
    saveConfig();
  }
  return getStatus();
}

function getStatus() {
  return {
    enabled: cfg.enabled,
    printerName: cfg.printerName,
    maxPerMinute: cfg.maxPerMinute,
    queued: queue.length,
    printing: printing,
    lastOk: lastResult.ok,
    lastError: lastResult.error,
    lastAt: lastResult.at,
    receiptCounter: receiptCounter,
    paper: paperState
  };
}

// ── Printer discovery ────────────────────────────────────────────────────────
function listPrinters() {
  return new Promise(function (resolve) {
    try {
      const ps = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
         'Get-Printer | Select-Object -ExpandProperty Name'],
        { windowsHide: true });
      let out = '';
      ps.stdout.on('data', function (d) { out += d.toString(); });
      ps.on('close', function () {
        resolve(out.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean));
      });
      ps.on('error', function () { resolve([]); });
    } catch (e) { resolve([]); }
  });
}

// ── Asset fetching (avatars, gift art) ──────────────────────────────────────
// Images are fetched main-process-side and handed to the render page as data
// URLs so the canvas is never CORS-tainted. Failures resolve null and the
// receipt falls back to the initials circle — a slow CDN never blocks a print.
function fetchDataUrl(url, cb, depth) {
  depth = depth || 0;
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url) || depth > 3) return cb(null);
  try {
    const mod = url.indexOf('https:') === 0 ? https : http;
    const req = mod.get(url, { timeout: 4000 }, function (res) {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
        res.resume();
        return fetchDataUrl(res.headers.location, cb, depth + 1);
      }
      if (res.statusCode !== 200) { res.resume(); return cb(null); }
      const chunks = [];
      let size = 0;
      res.on('data', function (c) {
        size += c.length;
        if (size > 1024 * 1024) { try { req.destroy(); } catch (e) {} return; }
        chunks.push(c);
      });
      res.on('end', function () {
        if (size === 0 || size > 1024 * 1024) return cb(null);
        const mime = (res.headers['content-type'] || 'image/png').split(';')[0];
        if (mime.indexOf('image/') !== 0) return cb(null);
        cb('data:' + mime + ';base64,' + Buffer.concat(chunks).toString('base64'));
      });
      res.on('error', function () { cb(null); });
    });
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} cb(null); });
    req.on('error', function () { cb(null); });
  } catch (e) { cb(null); }
}

// ── Hidden render window ─────────────────────────────────────────────────────
function ensureRenderWin() {
  return new Promise(function (resolve, reject) {
    if (renderWin && !renderWin.isDestroyed()) return resolve(renderWin);
    try {
      renderWin = new BrowserWindow({
        width: 600, height: 400, show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
      });
      renderWin.on('closed', function () { renderWin = null; });
      renderWin.loadFile(path.join(__dirname, 'printer-render.html')).then(function () {
        resolve(renderWin);
      }).catch(reject);
    } catch (e) { reject(e); }
  });
}

function renderReceipt(job) {
  return new Promise(function (resolve, reject) {
    ensureRenderWin().then(function (win) {
      const id = ++renderSeq;
      const chan = 'printer-render-done-' + id;
      const timer = setTimeout(function () {
        ipcMain.removeAllListeners(chan);
        reject(new Error('render timeout'));
      }, 12000);
      ipcMain.once(chan, function (ev, result) {
        clearTimeout(timer);
        if (result && result.ok) resolve(result);
        else reject(new Error((result && result.error) || 'render failed'));
      });
      win.webContents.send('printer-render-job', { id: id, job: job });
    }).catch(reject);
  });
}

// ── ESC/POS packing ──────────────────────────────────────────────────────────
// Raster comes back from the render page as packed 1bpp rows (widthBytes per
// row, MSB-first, 1 = ink), already bottom-cropped to the last ink row plus a
// small pad — so the only feed after the image is the printer's own
// feed-to-cutter (GS V 66 0), never blank paper we added.
function buildEscpos(rasterB64, widthBytes, height) {
  const raster = Buffer.from(rasterB64, 'base64');
  const parts = [];
  parts.push(Buffer.from([0x1b, 0x40]));             // ESC @ init
  parts.push(Buffer.from([0x1b, 0x61, 0x01]));       // center (harmless for raster)
  const BAND = 256;                                   // chunk tall images for buffer-limited firmware
  for (let y0 = 0; y0 < height; y0 += BAND) {
    const rows = Math.min(BAND, height - y0);
    parts.push(Buffer.from([0x1d, 0x76, 0x30, 0x00,
      widthBytes & 0xff, (widthBytes >> 8) & 0xff,
      rows & 0xff, (rows >> 8) & 0xff]));
    parts.push(raster.slice(y0 * widthBytes, (y0 + rows) * widthBytes));
  }
  parts.push(Buffer.from([0x1d, 0x56, 0x42, 0x00])); // GS V B 0: feed to cut position + partial cut
  return Buffer.concat(parts);
}

// ── Raw spool via winspool ───────────────────────────────────────────────────
const RAWPRINT_PS = [
  'param([string]$PrinterName,[string]$FilePath)',
  '$ErrorActionPreference = "Stop"',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class SFRawPrint {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]',
  '  public class DOCINFOA {',
  '    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;',
  '    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;',
  '    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;',
  '  }',
  '  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]',
  '  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);',
  '  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]',
  '  public static extern bool ClosePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]',
  '  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);',
  '  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]',
  '  public static extern bool EndDocPrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]',
  '  public static extern bool StartPagePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]',
  '  public static extern bool EndPagePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]',
  '  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);',
  '  public static bool Send(string printer, byte[] data) {',
  '    IntPtr h; if (!OpenPrinter(printer, out h, IntPtr.Zero)) return false;',
  '    DOCINFOA di = new DOCINFOA(); di.pDocName = "StreamFusion Receipt"; di.pDataType = "RAW";',
  '    bool ok = false;',
  '    if (StartDocPrinter(h, 1, di)) {',
  '      if (StartPagePrinter(h)) {',
  '        int w; ok = WritePrinter(h, data, data.Length, out w) && w == data.Length;',
  '        EndPagePrinter(h);',
  '      }',
  '      EndDocPrinter(h);',
  '    }',
  '    ClosePrinter(h); return ok;',
  '  }',
  '}',
  '"@',
  '$bytes = [System.IO.File]::ReadAllBytes($FilePath)',
  'if ([SFRawPrint]::Send($PrinterName, $bytes)) { Write-Output "OK" } else { Write-Output "FAIL"; exit 1 }'
].join('\r\n');

function spoolScriptPath() {
  const p = path.join(app.getPath('userData'), 'sf-rawprint.ps1');
  try {
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== RAWPRINT_PS) fs.writeFileSync(p, RAWPRINT_PS);
  } catch (e) {}
  return p;
}

function spool(bytes) {
  return new Promise(function (resolve, reject) {
    if (!cfg.printerName) return reject(new Error('no printer selected'));
    const bin = path.join(app.getPath('userData'), 'sf-receipt.bin');
    try { fs.writeFileSync(bin, bytes); } catch (e) { return reject(e); }
    try {
      const ps = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
         '-File', spoolScriptPath(), '-PrinterName', cfg.printerName, '-FilePath', bin],
        { windowsHide: true });
      let out = '', err = '';
      ps.stdout.on('data', function (d) { out += d.toString(); });
      ps.stderr.on('data', function (d) { err += d.toString(); });
      const timer = setTimeout(function () { try { ps.kill(); } catch (e) {} }, 20000);
      ps.on('close', function (code) {
        clearTimeout(timer);
        if (code === 0 && out.indexOf('OK') !== -1) resolve();
        else reject(new Error('spool failed: ' + (err || out || ('exit ' + code)).trim().slice(0, 300)));
      });
      ps.on('error', function (e) { clearTimeout(timer); reject(e); });
    } catch (e) { reject(e); }
  });
}

// ── Queue ────────────────────────────────────────────────────────────────────
function rateLimited() {
  const now = Date.now();
  recent = recent.filter(function (t) { return now - t < 60000; });
  return recent.length >= cfg.maxPerMinute;
}

// enqueue(job) → { queued, reason?, receiptNo? }
// job: { platform, user, action, avatarUrl, giftIconUrl, giftLabel, banner,
//        bannerInverse, bigNum, bigNumLabel, message, recipients, rows,
//        footer, isTest }
function enqueue(job) {
  if (!job || typeof job !== 'object') return { queued: false, reason: 'bad job' };
  if (!cfg.enabled && !job.isTest) return { queued: false, reason: 'disabled' };
  if (!cfg.printerName) return { queued: false, reason: 'no printer selected' };
  if (queue.length >= 20) return { queued: false, reason: 'queue full' };
  if (!job.isTest && rateLimited()) return { queued: false, reason: 'rate' };
  receiptCounter++;
  saveConfig();
  job._receiptNo = receiptCounter;
  if (!job.isTest) recent.push(Date.now());
  queue.push(job);
  pump();
  return { queued: true, receiptNo: receiptCounter };
}

function pump() {
  if (printing || queue.length === 0) return;
  printing = true;
  const job = queue.shift();
  const finish = function (ok, errMsg) {
    lastResult = { ok: ok, at: Date.now(), error: errMsg || '' };
    if (!ok) logFn('printer: ' + errMsg);
    printing = false;
    setTimeout(pump, 300);
  };
  // Enrich with fetched image data, then render + spool.
  fetchDataUrl(job.avatarUrl, function (avatarData) {
    fetchDataUrl(job.giftIconUrl, function (giftData) {
      job.avatarData = avatarData;
      job.giftIconData = giftData;
      renderReceipt(job).then(function (r) {
        return spool(buildEscpos(r.rasterB64, r.widthBytes, r.height));
      }).then(function () {
        finish(true);
      }).catch(function (e) {
        finish(false, (e && e.message) || 'print failed');
      });
    });
  });
}

function stop() {
  try { if (renderWin && !renderWin.isDestroyed()) renderWin.destroy(); } catch (e) {}
  renderWin = null;
  if (paperTimer) { clearInterval(paperTimer); paperTimer = null; }
}

module.exports = {
  init: init,
  setConfig: setConfig,
  getStatus: getStatus,
  listPrinters: listPrinters,
  enqueue: enqueue,
  stop: stop
};
