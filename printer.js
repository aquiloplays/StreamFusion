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

let cfg = { enabled: false, printerName: '', maxPerMinute: 6, discordWebhook: '', theme: 'auto', flair: true, galleryKey: '' };

// ── Viewer flair ─────────────────────────────────────────────────────────────
// Viewers customize their receipts at aquilo.gg/printflair (icon + tagline,
// server-validated). Fetched per Twitch login at print time, 6h cache;
// any failure just prints plain.
const flairCache = new Map();
function fetchFlair(job, cb) {
  let done = false;
  const fin = function () { if (!done) { done = true; cb(); } };
  try {
    if (!cfg.flair || job.isTest || !job.user || job.platform !== 'tw') return fin();
    const login = String(job.user).trim().toLowerCase();
    if (!/^[a-z0-9_]{2,26}$/.test(login)) return fin();
    const hit = flairCache.get(login);
    if (hit && Date.now() - hit.at < 6 * 3600e3) { applyFlair(job, hit.data); return fin(); }
    const req = https.get('https://loadout-discord.aquiloplays.workers.dev/api/printflair/get?login=' + login,
      { timeout: 3000 }, function (res) {
        let out = '';
        res.on('data', function (c) { out += c; if (out.length > 4096) { try { req.destroy(); } catch (e) {} } });
        res.on('end', function () {
          let d = null;
          try { d = JSON.parse(out); } catch (e) {}
          if (flairCache.size > 300) flairCache.clear();
          flairCache.set(login, { data: d, at: Date.now() });
          applyFlair(job, d); fin();
        });
        res.on('error', fin);
      });
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} fin(); });
    req.on('error', fin);
  } catch (e) { fin(); }
}
// ── Receipt gallery ──────────────────────────────────────────────────────────
// Fire-and-forget mirror of each real receipt PNG to the aquilo.gg wall
// (worker /api/printflair/receipt, shared-key header). galleryKey lives in
// printer-config.json only (seeded, no UI); unset = feature off.
function sendGallery(pngB64, job) {
  if (!cfg.galleryKey || !pngB64 || pngB64.length > 500000) return;
  try {
    const body = JSON.stringify({ no: job._receiptNo || 0, kind: job._kind || '', user: job.user || '', png: pngB64 });
    const req = https.request('https://loadout-discord.aquiloplays.workers.dev/api/printflair/receipt', {
      method: 'POST', timeout: 10000,
      headers: { 'content-type': 'application/json', 'x-aquilo-print-key': cfg.galleryKey, 'content-length': Buffer.byteLength(body) }
    }, function (res) {
      if (res.statusCode >= 400) logFn('gallery HTTP ' + res.statusCode);
      res.resume();
    });
    req.on('error', function (e) { logFn('gallery: ' + (e && e.message)); });
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} });
    req.end(body);
  } catch (e) {}
}

// ── Meme prints ──────────────────────────────────────────────────────────────
// "Print a Meme" redeems carry memeQuery: resolve the top result via the
// loadout worker's cached Giphy proxy (pg-13 rated) and print its first
// frame big. Any failure prints the receipt without an image.
function fetchMeme(job, cb) {
  let done = false;
  const fin = function () { if (!done) { done = true; cb(); } };
  try {
    if (!job.memeQuery) return fin();
    const req = https.get('https://loadout-discord.aquiloplays.workers.dev/api/printflair/meme?q=' +
      encodeURIComponent(String(job.memeQuery).slice(0, 60)),
      { timeout: 5000 }, function (res) {
        let out = '';
        res.on('data', function (c) { out += c; if (out.length > 65536) { try { req.destroy(); } catch (e) {} } });
        res.on('end', function () {
          try {
            const j = JSON.parse(out);
            const m = j && j.meme;
            if (m && m.url) return fetchDataUrl(m.url, function (d) { job.bigImageData = d; fin(); });
          } catch (e) {}
          fin();
        });
        res.on('error', fin);
      });
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} fin(); });
    req.on('error', fin);
  } catch (e) { fin(); }
}

function applyFlair(job, d) {
  if (d && (d.icon || d.tagline || d.frame || d.shape || d.nameStyle || d.emoteUrl)) {
    job.flairEmoteUrl = (typeof d.emoteUrl === 'string' && d.emoteUrl.indexOf('https://static-cdn.jtvnw.net/emoticons/v2/') === 0) ? d.emoteUrl : '';
    job.flairIcon = String(d.icon || '');
    job.flairTag = String(d.tagline || '').slice(0, 40);
    job.flairFrame = ['double', 'dashed', 'zigzag', 'dots'].indexOf(d.frame) !== -1 ? d.frame : '';
    job.flairShape = ['squircle', 'hex', 'diamond'].indexOf(d.shape) !== -1 ? d.shape : '';
    job.flairName = ['pill', 'outline'].indexOf(d.nameStyle) !== -1 ? d.nameStyle : '';
  }
}

// 'auto' follows the meteorological calendar; 'off' prints plain.
function resolveTheme() {
  if (cfg.theme === 'off') return '';
  if (cfg.theme && cfg.theme !== 'auto') return cfg.theme;
  const m = new Date().getMonth();
  return m <= 1 || m === 11 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
}
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
    if (typeof patch.discordWebhook === 'string') cfg.discordWebhook = patch.discordWebhook.trim();
    if (typeof patch.theme === 'string' && ['auto', 'off', 'spring', 'summer', 'autumn', 'winter'].indexOf(patch.theme) !== -1) cfg.theme = patch.theme;
    if (typeof patch.flair === 'boolean') cfg.flair = patch.flair;
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
    paper: paperState,
    discordWebhook: cfg.discordWebhook || '',
    theme: cfg.theme || 'auto',
    flair: cfg.flair !== false
  };
}

// ── Discord mirror ───────────────────────────────────────────────────────────
// Fire-and-forget: after a real receipt prints, post its paper-styled PNG to
// the configured webhook (multipart, payload_json + files[0]). Failures log
// and never block the print queue. Test prints and system tickets skip it.
function sendDiscord(pngB64, job) {
  const url = cfg.discordWebhook;
  if (!url || url.indexOf('https://discord.com/api/webhooks/') !== 0 || !pngB64) return;
  try {
    const no = String(job._receiptNo || 0).padStart(4, '0');
    const boundary = '----sfreceipt' + Date.now().toString(36);
    const payload = JSON.stringify({ content: '🧾 receipt #' + no });
    const head = Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="payload_json"\r\n' +
      'Content-Type: application/json\r\n\r\n' + payload + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="files[0]"; filename="receipt-' + no + '.png"\r\n' +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([head, Buffer.from(pngB64, 'base64'), tail]);
    const req = https.request(url, {
      method: 'POST', timeout: 8000,
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    }, function (res) {
      if (res.statusCode >= 400) logFn('discord mirror HTTP ' + res.statusCode);
      res.resume();
    });
    req.on('error', function (e) { logFn('discord mirror: ' + (e && e.message)); });
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} });
    req.end(body);
  } catch (e) { logFn('discord mirror threw: ' + (e && e.message)); }
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
  if (job.theme === undefined) job.theme = resolveTheme();
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
      fetchFlair(job, function () {
      fetchDataUrl(job.flairEmoteUrl, function (emoteData) {
      job.flairEmoteData = emoteData;
      fetchMeme(job, function () {
      renderReceipt(job).then(function (r) {
        return spool(buildEscpos(r.rasterB64, r.widthBytes, r.height)).then(function () { return r; });
      }).then(function (r) {
        if (!job.isTest) { sendDiscord(r.pngB64, job); sendGallery(r.pngB64, job); }
        finish(true);
      }).catch(function (e) {
        finish(false, (e && e.message) || 'print failed');
      });
      });
      });
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
