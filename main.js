const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

// ── Patreon entitlement service ─────────────────────────────────────────────
// Optional sign-in; the app boots for everyone. Active Tier 2 / Tier 3
// supporters unlock Early Access (EA) features live. See patreon-auth.js.
const patreonAuth = require('./patreon-auth');

// ── OBS overlay server (EA-only) ────────────────────────────────────────────
// Local HTTP + SSE server that powers browser-source overlays (chat feed,
// alerts, shoutouts) for OBS. Starts on app launch and stays up regardless
// of entitlement so URLs are always reachable, but serves the "Early Access
// required" page for non-entitled users. See obs-server.js.
const obsServer = require('./obs-server');

// ── Crash / error logging ───────────────────────────────────────────────────
function getLogPath() {
  try { return path.join(app.getPath('userData'), 'streamfusion-crash.log'); }
  catch (e) { return path.join(__dirname, 'streamfusion-crash.log'); }
}
function logToFile(level, msg) {
  try {
    var ts = new Date().toISOString();
    fs.appendFileSync(getLogPath(), '[' + ts + '] [' + level + '] ' + msg + '\n');
  } catch (e) {}
}
process.on('uncaughtException', function(err) {
  logToFile('FATAL', 'Uncaught exception: ' + (err && err.stack ? err.stack : err));
  console.error('[StreamFusion] uncaught exception:', err);
});
process.on('unhandledRejection', function(reason) {
  logToFile('ERROR', 'Unhandled rejection: ' + (reason && reason.stack ? reason.stack : reason));
  console.error('[StreamFusion] unhandled rejection:', reason);
});

// ── Auto-updater ────────────────────────────────────────────────────────────
// Uses electron-updater when available (packaged build). In dev mode the
// module won't exist, so we silently skip.
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  // electron-updater's electron-log dependency expects a full logger interface.
  // Missing methods (debug/verbose/silly) throw "X is not a function" and kill
  // the update flow silently. Provide all methods to be safe.
  autoUpdater.logger = {
    info:    function(m) { logToFile('UPDATE',       m); },
    warn:    function(m) { logToFile('UPDATE-WARN',  m); },
    error:   function(m) { logToFile('UPDATE-ERR',   m); },
    debug:   function(m) { logToFile('UPDATE-DEBUG', m); },
    verbose: function(m) { logToFile('UPDATE-VERB',  m); },
    silly:   function(m) { /* too noisy — drop */ }
  };
  logToFile('UPDATE', 'electron-updater loaded ok');
} catch (e) {
  // electron-updater not available (dev mode, or wasn't bundled)
  logToFile('UPDATE-ERR', 'electron-updater require failed: ' + (e && e.message ? e.message : e));
}

// ── StreamFusion icon generator (pure JS, no dependencies) ───────────────────
function buildSFIcon() {
  const W = 256, H = 256;
  const px = Buffer.alloc(W * H * 4, 0);

  // Alpha-compositing pixel setter
  function sp(x, y, r, g, b, a) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4, fa = a / 255, ba = px[i+3] / 255, oa = fa + ba * (1 - fa);
    if (oa <= 0) return;
    px[i]   = Math.round((r * fa + px[i]   * ba * (1-fa)) / oa);
    px[i+1] = Math.round((g * fa + px[i+1] * ba * (1-fa)) / oa);
    px[i+2] = Math.round((b * fa + px[i+2] * ba * (1-fa)) / oa);
    px[i+3] = Math.round(oa * 255);
  }

  // Anti-aliased circle drawing
  function drawCircle(cx, cy, radius, r, g, b, a, aa=2) {
    const r2 = radius * radius;
    for (let y = cy - radius - 1; y <= cy + radius + 1; y++) {
      for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
        const dx = x - cx, dy = y - cy, dist2 = dx*dx + dy*dy;
        if (dist2 > (radius+1)*(radius+1)) continue;
        const alpha = Math.max(0, Math.min(1, radius + .5 - Math.sqrt(dist2)));
        sp(x, y, r, g, b, Math.round(a * alpha));
      }
    }
  }

  // Scan-line polygon fill
  function fillPoly(verts, cfn) {
    const ys = verts.map(v=>v[1]);
    const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
    for (let y = y0; y <= y1; y++) {
      const xs = [];
      for (let i = 0; i < verts.length; i++) {
        const [ax,ay] = verts[i], [bx,by] = verts[(i+1)%verts.length];
        if ((ay <= y && by > y) || (by <= y && ay > y))
          xs.push(ax + (y-ay)*(bx-ax)/(by-ay));
      }
      xs.sort((a,b) => a-b);
      for (let j = 0; j < xs.length-1; j += 2) {
        const [r,g,b] = typeof cfn === 'function' ? cfn(y) : cfn;
        for (let x = Math.ceil(xs[j]); x <= Math.floor(xs[j+1]); x++) sp(x, y, r, g, b, 255);
      }
    }
  }

  // Draw gradient stroke around circle edge
  function drawRing(cx, cy, r1, r2, cfn) {
    for (let y = cy - r2 - 1; y <= cy + r2 + 1; y++) {
      for (let x = cx - r2 - 1; x <= cx + r2 + 1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < r1 || d > r2 + 1) continue;
        const t = (d - r1) / (r2 - r1);
        const alpha = Math.max(0, Math.min(1, 1 - Math.max(0, d - r2)));
        const [r,g,b] = cfn(x, y, t);
        sp(x, y, r, g, b, Math.round(alpha * 255));
      }
    }
  }

  // Banner palette (aquilo.gg Discord Nitro banner, discord-profile-banner.html).
  // Keep the icon visually consistent with that branding:
  //   BLUE  #3A86FF — primary accent
  //   TEAL  #2AD4B9 — secondary accent
  //   WHITE #efeff1 — bolt highlight (top of gradient)
  //   DARK  #0e0e10 — interior fill (matches app background)
  const BLUE  = [ 58, 134, 255];
  const TEAL  = [ 42, 212, 185];
  const WHITE = [239, 239, 241];
  const DARK  = [ 14,  14,  16];

  const cx = W/2, cy = H/2;

  // === 1. Subtle blue glow (mirrors the banner's CSS drop-shadow) ===
  // Peak ~5% opacity just outside the ring, fading to 0 over 12px. Lower
  // intensity than a CSS drop-shadow would give you because the tray /
  // taskbar renders the icon at 16-32px — a big halo there looks like
  // rendering noise, not polish.
  for (let r = 140; r >= 128; r--) {
    const glow = Math.round(((140 - r) / 12) * 14);
    drawCircle(cx, cy, r, BLUE[0], BLUE[1], BLUE[2], glow);
  }

  // === 2. Dark interior fill ===
  // Filled solid to r=119 so the thick ring stroke sits cleanly on the edge
  // without any transparent gap (unlike the banner, we render against any
  // background — taskbar, title bar, tray — so the fill must be opaque).
  drawCircle(cx, cy, 119, DARK[0], DARK[1], DARK[2], 255);

  // === 3. Main ring — diagonal blue→teal gradient ===
  // Matches banner's linearGradient from top-left to bottom-right.
  drawRing(cx, cy, 119, 127, function(x, y) {
    const t = Math.max(0, Math.min(1, (x + y) / (W + H)));
    return [
      Math.round(BLUE[0] + (TEAL[0] - BLUE[0]) * t),
      Math.round(BLUE[1] + (TEAL[1] - BLUE[1]) * t),
      Math.round(BLUE[2] + (TEAL[2] - BLUE[2]) * t)
    ];
  });

  // === 4. Subtle inner ring (40% opacity over dark fill) ===
  // Banner has `<circle r="45" stroke-width="1" opacity="0.4">` just inside
  // the main ring — a whisper-thin accent. drawRing only returns RGB, so
  // we simulate the 40% opacity by blending toward the dark interior.
  drawRing(cx, cy, 113, 115, function(x, y) {
    const t = Math.max(0, Math.min(1, (x + y) / (W + H)));
    const r = BLUE[0] + (TEAL[0] - BLUE[0]) * t;
    const g = BLUE[1] + (TEAL[1] - BLUE[1]) * t;
    const b = BLUE[2] + (TEAL[2] - BLUE[2]) * t;
    return [
      Math.round(r * 0.4 + DARK[0] * 0.6),
      Math.round(g * 0.4 + DARK[1] * 0.6),
      Math.round(b * 0.4 + DARK[2] * 0.6)
    ];
  });

  // === 5. Lightning bolt — banner path, vertical 3-stop gradient ===
  // Banner path (100x100 viewBox):
  //   M 55 20 L 32 52 L 46 52 L 42 80 L 66 46 L 52 46 Z
  // Scaled to 256x256 by *2.56 and rounded to integer pixels.
  // Gradient stops match banner's `bolt-grad`:
  //   y=51  (top)     → white
  //   y=105 (~35%)    → blue
  //   y=205 (bottom)  → teal
  function boltColor(y) {
    if (y <= 105) {
      const t = Math.max(0, Math.min(1, (y - 51) / 54));
      return [
        Math.round(WHITE[0] + (BLUE[0] - WHITE[0]) * t),
        Math.round(WHITE[1] + (BLUE[1] - WHITE[1]) * t),
        Math.round(WHITE[2] + (BLUE[2] - WHITE[2]) * t)
      ];
    }
    const t = Math.max(0, Math.min(1, (y - 105) / 100));
    return [
      Math.round(BLUE[0] + (TEAL[0] - BLUE[0]) * t),
      Math.round(BLUE[1] + (TEAL[1] - BLUE[1]) * t),
      Math.round(BLUE[2] + (TEAL[2] - BLUE[2]) * t)
    ];
  }

  fillPoly([
    [141,  51], [ 82, 133], [118, 133],
    [108, 205], [169, 118], [133, 118]
  ], boltColor);

  return encodePNG(W, H, px);
}

function encodePNG(W, H, px) {
  // CRC32 table
  const T = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c=i; for (let j=0;j<8;j++) c=(c&1)?0xEDB88320^(c>>>1):c>>>1; T[i]=c; }
  function crc32(b) { let c=0xFFFFFFFF; for (let i=0;i<b.length;i++) c=T[(c^b[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
  function adler32(b) { let s1=1,s2=0; for (let i=0;i<b.length;i++){s1=(s1+b[i])%65521;s2=(s2+s1)%65521;} return ((s2 * 65536 + s1) >>> 0); }
  function mkChunk(type, data) {
    const tb=Buffer.from(type,'ascii'), lb=Buffer.alloc(4), cb=Buffer.alloc(4);
    lb.writeUInt32BE(data.length,0); cb.writeUInt32BE(crc32(Buffer.concat([tb,data])),0);
    return Buffer.concat([lb,tb,data,cb]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(H,4); ihdr[8]=8; ihdr[9]=6;
  // Raw scanlines with filter-0 bytes
  const rowLen = W*4, raw = Buffer.alloc(H*(rowLen+1));
  for (let y=0;y<H;y++) { raw[y*(rowLen+1)]=0; px.copy(raw, y*(rowLen+1)+1, y*rowLen, (y+1)*rowLen); }
  // zlib store — split into 65535-byte blocks to support any image size
  const BLOCK = 65535;
  const numBlocks = Math.ceil(raw.length / BLOCK);
  const blocks = [];
  for (let b = 0; b < numBlocks; b++) {
    const chunk = raw.slice(b * BLOCK, Math.min((b+1) * BLOCK, raw.length));
    const isLast = b === numBlocks - 1;
    const hdr = Buffer.alloc(5);
    hdr[0] = isLast ? 0x01 : 0x00;
    hdr.writeUInt16LE(chunk.length, 1);
    hdr.writeUInt16LE((~chunk.length) & 0xFFFF, 3);
    blocks.push(hdr, chunk);
  }
  const adBuf = Buffer.alloc(4); adBuf.writeUInt32BE(adler32(raw), 0);
  const idat = Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks, adBuf]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),mkChunk('IHDR',ihdr),mkChunk('IDAT',idat),mkChunk('IEND',Buffer.alloc(0))]);
}

// Keep references so they don't get garbage collected
let mainWindow = null;
let overlayWindow = null;
let bannerWindow = null;
// Hidden "promo" overlay window — a brand-advertisement variant of the pop-out
// that streamers can window-capture in OBS to show viewers what StreamFusion
// looks like while their stream runs. Opaque background, big type, no
// revenue data, "Download at aquilo.gg" footer. Gated behind a hidden
// settings button so regular users never see it.
let promoWindow = null;
let tray = null;
let isQuitting = false;
let overlayHotkeyAccel = 'CommandOrControl+Shift+L';
// Mouse4/Mouse5 cannot be registered via Electron globalShortcut. When the
// user picks one of those, we record it here and the PowerShell input poller
// (further down) watches the corresponding XButton state and emits the
// toggle event itself.
let overlayHotkeyMouseButton = null; // null | 'Mouse4' | 'Mouse5'
// Separate hotkey for toggling overlay visibility (hide/show). Lets the
// streamer quickly hide the pop-out from their own screen without losing
// its position / state. Defaults to Ctrl+Shift+H.
let overlayVisHotkeyAccel = 'CommandOrControl+Shift+H';
// Remembered bounds from the last time the overlay was hidden, so show()
// restores the exact position (Electron preserves bounds across hide/show
// on its own, but we snapshot anyway in case the user resizes while hidden).
let overlayHiddenBounds = null;
// Multi-monitor snap: persist overlay position + display across sessions
function getOverlayBoundsPath() { return path.join(app.getPath('userData'), 'overlay-bounds.json'); }
function saveOverlayBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    var b = overlayWindow.getBounds();
    fs.writeFileSync(getOverlayBoundsPath(), JSON.stringify(b));
  } catch (e) {}
}
function loadOverlayBounds() {
  try {
    var raw = fs.readFileSync(getOverlayBoundsPath(), 'utf8');
    var b = JSON.parse(raw);
    // Validate the saved position is still on a connected display
    const { screen } = require('electron');
    var displays = screen.getAllDisplays();
    var onScreen = displays.some(function(d) {
      return b.x >= d.bounds.x - 50 && b.x < d.bounds.x + d.bounds.width + 50
          && b.y >= d.bounds.y - 50 && b.y < d.bounds.y + d.bounds.height + 50;
    });
    return onScreen ? b : null;
  } catch (e) { return null; }
}

// Toggle the overlay window's visibility. Electron preserves the window
// position across hide/show, so the streamer can duck the pop-out with a
// hotkey and bring it back in the same place. If the overlay hasn't been
// created yet, a press does nothing (the user has to open it first from the
// main app's pop-out button).
function toggleOverlayVisibility() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (overlayWindow.isVisible()) {
    try { overlayHiddenBounds = overlayWindow.getBounds(); } catch (e) {}
    try { overlayWindow.hide(); } catch (e) {}
  } else {
    try {
      if (overlayHiddenBounds) overlayWindow.setBounds(overlayHiddenBounds);
      overlayWindow.show();
    } catch (e) {}
  }
}

// Re-register BOTH overlay hotkeys. We have to call unregisterAll and then
// re-register both because Electron has no way to unregister a single
// accelerator by callback identity.
function registerAllOverlayHotkeys() {
  try { globalShortcut.unregisterAll(); } catch (e) {}
  // Interact hotkey (unless user picked a mouse button — that one runs
  // through the PowerShell poller instead)
  if (overlayHotkeyAccel && overlayHotkeyAccel !== 'Mouse4' && overlayHotkeyAccel !== 'Mouse5') {
    try {
      globalShortcut.register(overlayHotkeyAccel, () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('overlay-toggle-interact');
        }
      });
    } catch (e) { console.error('[overlay] failed to register interact hotkey', overlayHotkeyAccel, e); }
  }
  // Visibility toggle hotkey
  if (overlayVisHotkeyAccel) {
    try {
      globalShortcut.register(overlayVisHotkeyAccel, toggleOverlayVisibility);
    } catch (e) { console.error('[overlay] failed to register vis hotkey', overlayVisHotkeyAccel, e); }
  }
}

function registerOverlayHotkey(accel) {
  overlayHotkeyMouseButton = null;
  if (!accel) { overlayHotkeyAccel = ''; registerAllOverlayHotkeys(); return false; }
  // Mouse buttons aren't real Electron accelerators — handle them via the poller
  if (accel === 'Mouse4' || accel === 'Mouse5') {
    overlayHotkeyMouseButton = accel;
    overlayHotkeyAccel = accel;
    registerAllOverlayHotkeys();
    return true;
  }
  overlayHotkeyAccel = accel;
  registerAllOverlayHotkeys();
  // Best-effort: check that the keyboard accelerator is actually bound
  try { return globalShortcut.isRegistered(accel); } catch (e) { return true; }
}

function registerOverlayVisHotkey(accel) {
  overlayVisHotkeyAccel = accel || '';
  registerAllOverlayHotkeys();
  try { return accel ? globalShortcut.isRegistered(accel) : true; } catch (e) { return true; }
}

// ── Global "hold Ctrl" detector ──────────────────────────────────────────────
// Electron's globalShortcut cannot register a single modifier key like Ctrl
// alone (it requires modifier+key combos). To support the requested
// "hold Ctrl to interact with the pop-out" UX even when the overlay window
// has no focus (e.g. while the streamer is playing a fullscreen game), we
// spawn a tiny PowerShell child process that polls the global Ctrl modifier
// state ~25× per second and prints "1"/"0" on changes. The main process
// reads stdout and forwards the state to the overlay renderer over IPC.
//
// Why PowerShell instead of a native module? Zero install / rebuild burden:
// PowerShell ships with every supported Windows version. uiohook-napi or
// similar would require electron-rebuild and prebuilt binaries.
let ctrlPoller = null;
let ctrlIsDown = false;
let mouse4WasDown = false;
let mouse5WasDown = false;
function startCtrlPoller() {
  if (ctrlPoller || process.platform !== 'win32') return;
  // PowerShell poller emits one of:
  //   C1 / C0      → Ctrl down/up (used for hold-to-interact)
  //   M4D / M4U    → XButton1 (Mouse4) down/up
  //   M5D / M5U    → XButton2 (Mouse5) down/up
  const psScript =
    "Add-Type -AssemblyName System.Windows.Forms;" +
    "$sig = '[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int vKey);';" +
    "$ks = Add-Type -MemberDefinition $sig -Name 'KS' -Namespace 'Win' -PassThru;" +
    "$lastC = ''; $lastM4 = $false; $lastM5 = $false;" +
    "while ($true) {" +
    "  $c = if ((([System.Windows.Forms.Control]::ModifierKeys) -band [System.Windows.Forms.Keys]::Control) -ne 0) {'1'} else {'0'};" +
    "  if ($c -ne $lastC) { [Console]::Out.WriteLine('C' + $c); [Console]::Out.Flush(); $lastC = $c }" +
    "  $m4 = ($ks::GetAsyncKeyState(0x05) -band 0x8000) -ne 0;" +
    "  if ($m4 -ne $lastM4) { [Console]::Out.WriteLine('M4' + $(if ($m4) {'D'} else {'U'})); [Console]::Out.Flush(); $lastM4 = $m4 }" +
    "  $m5 = ($ks::GetAsyncKeyState(0x06) -band 0x8000) -ne 0;" +
    "  if ($m5 -ne $lastM5) { [Console]::Out.WriteLine('M5' + $(if ($m5) {'D'} else {'U'})); [Console]::Out.Flush(); $lastM5 = $m5 }" +
    "  Start-Sleep -Milliseconds 40" +
    "}";
  try {
    ctrlPoller = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript], { windowsHide: true });
    ctrlPoller.stdout.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/);
      lines.forEach(line => {
        line = line.trim();
        if (!line) return;
        if (line === 'C1' && !ctrlIsDown) {
          ctrlIsDown = true;
          if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('overlay-hold-key', true);
        } else if (line === 'C0' && ctrlIsDown) {
          ctrlIsDown = false;
          if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('overlay-hold-key', false);
        } else if (line === 'M4D') {
          if (!mouse4WasDown) {
            mouse4WasDown = true;
            if (overlayHotkeyMouseButton === 'Mouse4' && overlayWindow && !overlayWindow.isDestroyed()) {
              overlayWindow.webContents.send('overlay-toggle-interact');
            }
          }
        } else if (line === 'M4U') {
          mouse4WasDown = false;
        } else if (line === 'M5D') {
          if (!mouse5WasDown) {
            mouse5WasDown = true;
            if (overlayHotkeyMouseButton === 'Mouse5' && overlayWindow && !overlayWindow.isDestroyed()) {
              overlayWindow.webContents.send('overlay-toggle-interact');
            }
          }
        } else if (line === 'M5U') {
          mouse5WasDown = false;
        }
      });
    });
    ctrlPoller.stderr.on('data', (d) => console.warn('[ctrl-poll]', d.toString()));
    ctrlPoller.on('exit', (code) => {
      console.log('[ctrl-poll] exited with code', code);
      ctrlPoller = null;
    });
    ctrlPoller.on('error', (err) => {
      console.error('[ctrl-poll] spawn failed:', err);
      ctrlPoller = null;
    });
  } catch (e) {
    console.error('[ctrl-poll] failed to start', e);
    ctrlPoller = null;
  }
}
function stopCtrlPoller() {
  if (ctrlPoller) {
    try { ctrlPoller.kill(); } catch (e) {}
    ctrlPoller = null;
  }
}

// ── Create the main window ──────────────────────────────────────────────────
function createWindow() {
  // Generate custom icon — write to userData (always writable, even from inside asar)
  let appIcon;
  try {
    const iconBuf = buildSFIcon();
    const iconPath = path.join(app.getPath('userData'), 'sf-icon.png');
    fs.writeFileSync(iconPath, iconBuf);
    appIcon = nativeImage.createFromPath(iconPath);
    if (appIcon.isEmpty()) appIcon = nativeImage.createFromBuffer(iconBuf);
  } catch(e) { appIcon = undefined; }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 520,
    minHeight: 400,
    title: 'StreamFusion',
    icon: appIcon || path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#0e0e10',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    // Frameless look — comment these out if you prefer the default OS titlebar
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'hiddenInset',
    titleBarOverlay: {
      color: '#18181b',
      symbolColor: '#adadb8',
      height: 32,
    },
    show: false, // show after ready-to-show
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Apply icon explicitly — more reliable on Windows than BrowserWindow option alone
  if (appIcon && !appIcon.isEmpty()) {
    try { mainWindow.setIcon(appIcon); } catch(e) {}
  }

  // Show window once content is ready (avoids flash of white)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (appIcon && !appIcon.isEmpty()) {
      try { mainWindow.setIcon(appIcon); } catch(e) {}
    }
  });

  // Explicit DevTools shortcuts (F12 and Ctrl+Shift+I)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    var isF12 = input.key === 'F12';
    var isCtrlShiftI = input.control && input.shift && (input.key === 'I' || input.key === 'i');
    if (isF12 || isCtrlShiftI) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Ask on close: minimize to tray or exit completely
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Minimize to Tray', 'Exit StreamFusion', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'StreamFusion',
        message: 'What would you like to do?',
        detail: 'Minimize keeps StreamFusion running in the background.',
      }).then(({ response }) => {
        if (response === 0) {
          mainWindow.hide();
          if (tray && process.platform === 'win32') {
            tray.displayBalloon({ iconType: 'info', title: 'StreamFusion', content: 'Still running. Right-click the tray icon to quit.' });
          }
        } else if (response === 1) {
          isQuitting = true;
          app.quit();
        }
        // response === 2 → Cancel, do nothing
      });
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // F12 opens DevTools for debugging
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') { mainWindow.webContents.toggleDevTools(); event.preventDefault(); }
  });

  // Open external links in the default browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

// ── System tray ─────────────────────────────────────────────────────────────
function createTray() {
  // Reuse the same programmatic SF icon for the tray
  let trayIcon;
  try {
    const iconBuf = buildSFIcon();
    trayIcon = nativeImage.createFromBuffer(iconBuf);
    // Resize to 16x16 for crisp tray rendering on Windows
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('StreamFusion v' + app.getVersion() + ' — Running');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'StreamFusion v' + app.getVersion(), enabled: false },
    { type: 'separator' },
    {
      label: 'Show StreamFusion',
      click: () => { mainWindow?.show(); mainWindow?.focus(); },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    }
  });
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// ── Single-instance lock ─────────────────────────────────────────────────────
// Without this, "closing" StreamFusion (which actually minimizes to tray) and
// then double-clicking the .exe again silently spawned a half-broken second
// instance — symptom: "nothing happens". With the lock, the second launch
// resurfaces the existing window instead.
const _gotLock = app.requestSingleInstanceLock();
if (!_gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      // Edge case: lock is held but window is gone. Recreate.
      try { createWindow(); } catch (e) { console.error('[single-instance] recreate failed', e); }
    }
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createTray();
  createWindow();
  startCtrlPoller();

  // Patreon entitlement service. Register IPC handlers and point it at the
  // main window so entitlement changes reach the renderer. Kick off a
  // launch-time check on a small delay so the renderer has had time to
  // wire up its listener. If the user is already signed in, start the
  // hourly re-verification loop too.
  patreonAuth.setMainWindow(mainWindow);
  patreonAuth.registerIpcHandlers();

  // OBS overlay server comes up alongside the main window. It always
  // listens (so the streamer can bookmark the URLs without worrying about
  // whether SF is "ready"), but it returns the gated page if the user
  // isn't an active Tier 2/3 supporter.
  obsServer.startServer().then(function(ok) {
    if (!ok) logToFile('OBS-SERVER', 'failed to start on default port');
  }).catch(function(e) {
    logToFile('OBS-SERVER-ERR', 'start threw: ' + (e && e.message));
  });

  // Entitlement flips update the server's gate flag so overlays show /
  // hide without an OBS-side refresh. Subscribing here ensures this is
  // wired up before the first getEntitlement() call below returns.
  patreonAuth.onEntitlementChange(function(state) {
    obsServer.setEntitled(!!(state && state.entitled));
  });

  setTimeout(function() {
    patreonAuth.getEntitlement().then(function(state) {
      if (state && state.signedIn) patreonAuth.startRuntimeChecks();
    }).catch(function(e) {
      logToFile('AUTH-ERR', 'launch entitlement check failed: ' + (e && e.message));
    });
  }, 2500);

  // Check for updates (non-blocking)
  if (autoUpdater) {
    autoUpdater.on('update-available', (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-available', { version: info.version });
      }
    });
    autoUpdater.on('update-downloaded', (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-downloaded', { version: info.version });
      }
    });
    setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (e) {} }, 8000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch (e) {}
  stopCtrlPoller();
  try { patreonAuth.stopRuntimeChecks(); } catch (e) {}
  try { obsServer.stopServer(); } catch (e) {}
});

// ── IPC handlers (called from renderer via preload) ──────────────────────────
ipcMain.handle('app-version', () => app.getVersion());

// ── OBS overlay IPC ─────────────────────────────────────────────────────────
// The renderer is the single source of truth for chat/events/shoutouts —
// it owns the Streamer.bot + Tikfinity WebSockets. When it receives a
// message or the streamer clicks a shoutout, it forwards the payload
// here, and we fan it out to every connected OBS browser source.
ipcMain.on('obs-broadcast-chat', function(event, data) {
  try { obsServer.broadcast('chat', data, 'chat'); } catch (e) {}
});
ipcMain.on('obs-broadcast-alert', function(event, data) {
  try { obsServer.broadcast('alert', data, 'alerts'); } catch (e) {}
});
ipcMain.on('obs-broadcast-shoutout', function(event, data) {
  try { obsServer.broadcast('shoutout', data, 'shoutout'); } catch (e) {}
});
// Per-overlay config (what to show, transparency, durations, etc.) — the
// settings panel in the renderer drives this. The server remembers the
// last config so new OBS connections render with it immediately.
ipcMain.on('obs-set-config', function(event, payload) {
  if (!payload || !payload.overlay || !payload.cfg) return;
  try { obsServer.setConfig(payload.overlay, payload.cfg); } catch (e) {}
});
// URLs + status for the settings panel to render.
ipcMain.handle('obs-get-status', function() {
  return {
    running: obsServer.isRunning(),
    clients: obsServer.connectedClients(),
    urls:    obsServer.getUrls()
  };
});
ipcMain.on('minimize-window', () => mainWindow?.minimize());
ipcMain.on('maximize-window', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('close-window', () => mainWindow?.hide()); // hides to tray
ipcMain.on('quit-app', () => { isQuitting = true; app.quit(); });

// Kick viewer count — public API, no auth required, fetched from main process to avoid CORS
ipcMain.handle('fetch-kick-viewers', async (event, slug) => {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'kick.com',
      path: '/api/v1/channels/' + encodeURIComponent(slug),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StreamFusion)', 'Accept': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j.livestream ? (j.livestream.viewer_count || 0) : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
});

// Twitch viewer count — decapi.me public API, no auth required. Returns a
// plain-text integer when live, or a string like "User is not live" when
// offline / invalid. We parse and return null on anything non-numeric so the
// renderer keeps the previous value instead of showing 0 while transient
// network failures are in flight. Streamer.bot can't reliably emit
// Twitch.PresentViewers events via wildcard subscribe, so this is our
// authoritative ongoing source of truth (initial count still comes from
// GetBroadcaster / SB events when they do fire).
ipcMain.handle('fetch-twitch-viewers', async (event, login) => {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'decapi.me',
      path: '/twitch/viewercount/' + encodeURIComponent(login),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StreamFusion)', 'Accept': 'text/plain' }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        var n = parseInt(String(data).trim(), 10);
        resolve(isFinite(n) && n >= 0 ? n : null);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
});

// ── Overlay (pop-out chat) window ──────────────────────────────────────────
function createOverlayWindow(opts) {
  console.log('[overlay] createOverlayWindow called', opts);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    console.log('[overlay] already exists, focusing');
    overlayWindow.show();
    overlayWindow.focus();
    return;
  }

  // Restore saved position from previous session (multi-monitor snap)
  var saved = loadOverlayBounds();
  if (saved && opts.x == null && opts.y == null) {
    opts.x = saved.x; opts.y = saved.y;
    if (!opts.width) opts.width = saved.width;
    if (!opts.height) opts.height = saved.height;
  }

  // Try transparent first; fall back to opaque dark window if it fails
  function buildWin(transparentMode) {
    var winOpts = {
      width: opts.width || 380,
      height: opts.height || 620,
      x: opts.x != null ? opts.x : undefined,
      y: opts.y != null ? opts.y : undefined,
      minWidth: 240,
      minHeight: 200,
      title: 'StreamFusion Overlay',
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      resizable: true,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        backgroundThrottling: false,
      },
    };
    if (transparentMode) {
      winOpts.transparent = true;
      winOpts.hasShadow = false;
      winOpts.backgroundColor = '#00000000';
    } else {
      winOpts.backgroundColor = '#0e0e10';
    }
    return new BrowserWindow(winOpts);
  }

  // Try transparent mode (true see-through over gameplay); fall back to opaque
  try {
    overlayWindow = buildWin(true);
    console.log('[overlay] created (transparent mode)');
  } catch (err) {
    console.error('[overlay] transparent failed, falling back to opaque:', err);
    try {
      overlayWindow = buildWin(false);
      console.log('[overlay] created (opaque fallback)');
    } catch (err2) {
      console.error('[overlay] window creation failed:', err2);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('overlay-closed');
      }
      return;
    }
  }

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html')).then(() => {
    console.log('[overlay] loadFile succeeded');
  }).catch((err) => {
    console.error('[overlay] loadFile failed:', err);
  });

  overlayWindow.webContents.on('did-finish-load', () => {
    console.log('[overlay] did-finish-load');
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show();
      overlayWindow.focus();
    }
    // Register default global hotkey for toggling overlay interactivity
    registerOverlayHotkey(overlayHotkeyAccel);
  });

  overlayWindow.webContents.on('did-fail-load', (e, code, desc) => {
    console.error('[overlay] did-fail-load:', code, desc);
  });

  // DevTools shortcut for the overlay window too
  overlayWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    var isF12 = input.key === 'F12';
    var isCtrlShiftI = input.control && input.shift && (input.key === 'I' || input.key === 'i');
    if (isF12 || isCtrlShiftI) {
      overlayWindow.webContents.toggleDevTools({ mode: 'detach' });
      event.preventDefault();
    }
  });

  // Save position on move/resize for multi-monitor snap
  overlayWindow.on('moved', saveOverlayBounds);
  overlayWindow.on('resized', saveOverlayBounds);

  overlayWindow.on('closed', () => {
    console.log('[overlay] closed');
    overlayWindow = null;
    try { globalShortcut.unregisterAll(); } catch (e) {}
    // Close the external banner window if it was open
    if (bannerWindow && !bannerWindow.isDestroyed()) {
      try { bannerWindow.close(); } catch (e) {}
      bannerWindow = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('overlay-closed');
    }
  });

  overlayWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('open-overlay', (event, opts) => {
  try {
    createOverlayWindow(opts || {});
    return true;
  } catch (err) {
    console.error('[overlay] open-overlay handler failed:', err);
    return false;
  }
});

ipcMain.on('close-overlay', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  // Also close the external banner window if open
  if (bannerWindow && !bannerWindow.isDestroyed()) {
    try { bannerWindow.close(); } catch (e) {}
    bannerWindow = null;
  }
});

// Forward data from main renderer to overlay
ipcMain.on('overlay-data', (event, payload) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-data', payload);
  }
});

// Overlay requests its current config/visibility settings
ipcMain.on('overlay-ready', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-ready');
  }
});

// Overlay opacity change
ipcMain.on('overlay-set-opacity', (event, val) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setOpacity(Math.max(0.1, Math.min(1, val)));
  }
});

// Let overlay toggle click-through. When enabling we forward mouse moves so
// hover effects still work; when disabling we MUST call without the second
// arg or Windows leaves the window in a half-forwarded state where clicks
// silently fail.
ipcMain.on('overlay-click-through', (event, enabled) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (enabled) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    overlayWindow.setIgnoreMouseEvents(false);
    // Re-focus so keyboard events can flow again
    try { overlayWindow.focus(); } catch (e) {}
  }
});

// Register / change the overlay interaction global hotkey
ipcMain.handle('overlay-set-hotkey', (event, accel) => {
  const ok = registerOverlayHotkey(accel || overlayHotkeyAccel);
  return { ok: ok, accel: overlayHotkeyAccel };
});
ipcMain.handle('overlay-get-hotkey', () => overlayHotkeyAccel);

// Visibility toggle hotkey — separate from interact hotkey. Hides/shows the
// overlay window without losing state or position.
ipcMain.handle('overlay-set-vis-hotkey', (event, accel) => {
  const ok = registerOverlayVisHotkey(accel == null ? overlayVisHotkeyAccel : accel);
  return { ok: ok, accel: overlayVisHotkeyAccel };
});
ipcMain.handle('overlay-get-vis-hotkey', () => overlayVisHotkeyAccel);
// Programmatic toggle (for a button in the main app UI, not just the hotkey)
ipcMain.on('overlay-toggle-visibility', () => toggleOverlayVisibility());

// Resize an already-open overlay window to a preset size. Preserves the
// window's current x/y by default so clicking "Tall" doesn't jump the window.
// If the overlay is not open, this silently no-ops (next open() reads the
// size from the renderer's stored preset instead).
ipcMain.on('overlay-set-bounds', (event, b) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!b || typeof b !== 'object') return;
  try {
    const cur = overlayWindow.getBounds();
    const next = {
      x: (typeof b.x === 'number') ? b.x : cur.x,
      y: (typeof b.y === 'number') ? b.y : cur.y,
      width: Math.max(240, typeof b.width === 'number' ? b.width : cur.width),
      height: Math.max(200, typeof b.height === 'number' ? b.height : cur.height),
    };
    overlayWindow.setBounds(next, true);
    // The hidden-bounds snapshot from the vis-hotkey toggle should also be
    // updated so a subsequent hide/show doesn't yank the window back to a
    // stale size.
    overlayHiddenBounds = next;
  } catch (e) {
    console.error('[overlay] overlay-set-bounds failed:', e);
  }
});

// Main app -> set / toggle overlay lock state from outside the overlay window
ipcMain.on('overlay-set-locked', (event, locked) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // `locked` may be undefined (toggle), true, or false. Forward as-is to the
  // overlay renderer which owns the canonical cfg + visual state.
  overlayWindow.webContents.send('overlay-external-lock', locked);
});

// Overlay -> main app: send a chat message. Forwarded to the main renderer
// which already owns the SB/Tikfinity websockets and per-platform chat send
// logic, so the overlay never needs platform credentials of its own.
ipcMain.on('overlay-send-chat', (event, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-send-chat', payload || {});
  }
});

// Overlay -> main app: broadcast current lock state so the header icon updates
ipcMain.on('overlay-lock-changed', (event, locked) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-lock-state', !!locked);
  }
});

// Overlay -> main app: fire a hotbar action by index. Forwarded to the main
// renderer which owns the SB websocket and fireHotbarAction() logic.
ipcMain.on('overlay-fire-hotbar', (event, idx) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-fire-hotbar', idx);
  }
});

// Overlay -> main app: mod action (timeout/ban/delete). Forwarded to the main
// renderer which owns the SB websocket and modAction() logic.
ipcMain.on('overlay-mod-action', (event, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-mod-action', payload || {});
  }
});

// Main renderer -> overlay window: physical shake animation via setPosition.
// Fired when a big paid event happens (tip, gift bomb, big cheer, high tier sub).
// We intentionally do a short, punchy shake with decaying amplitude — just enough
// to make the pop-out feel "hit" without being distracting during a live stream.
let _overlayShakeTimer = null;
ipcMain.on('overlay-shake', (event, intensity) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (_overlayShakeTimer) {
    clearInterval(_overlayShakeTimer);
    _overlayShakeTimer = null;
  }
  const amp = Math.max(1, Math.min(3, Number(intensity) || 1));
  const [ox, oy] = overlayWindow.getPosition();
  // Decaying horizontal+vertical offsets (px) for ~420ms of shake
  const pattern = [
    [ 14,  -6], [-16,   7], [ 12,  -5], [-13,   5],
    [ 10,  -4], [-11,   4], [  8,  -3], [ -9,   3],
    [  6,  -2], [ -7,   2], [  4,  -2], [ -4,   1],
    [  2,  -1], [ -2,   1], [  1,   0], [  0,   0]
  ];
  let i = 0;
  _overlayShakeTimer = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      clearInterval(_overlayShakeTimer);
      _overlayShakeTimer = null;
      return;
    }
    if (i >= pattern.length) {
      overlayWindow.setPosition(ox, oy);
      clearInterval(_overlayShakeTimer);
      _overlayShakeTimer = null;
      return;
    }
    const dx = Math.round(pattern[i][0] * amp);
    const dy = Math.round(pattern[i][1] * amp);
    try { overlayWindow.setPosition(ox + dx, oy + dy); } catch (e) {}
    i++;
  }, 26);
});

// ── External banner window (big notifications beside the overlay) ───────────
// Instead of rendering big banners (subs, cheers, raids, etc.) inside the
// overlay where they can get clipped by the monitor edge, we create a
// separate transparent window positioned adjacent to the pop-out. The
// overlay tells us "show-external-banner" with the data, and we decide
// whether the banner window sits to the left or right of the overlay.
let _bannerHideTimer = null;
let _bannerPendingData = null;

function ensureBannerWindow(side, callback) {
  // If already exists and not destroyed, reposition and reuse
  if (bannerWindow && !bannerWindow.isDestroyed()) {
    positionBannerWindow(side);
    if (callback) callback();
    return;
  }
  // Create a new transparent frameless window for the banner
  const ovBounds = overlayWindow && !overlayWindow.isDestroyed()
    ? overlayWindow.getBounds()
    : { x: 200, y: 100, width: 380, height: 620 };
  const bnrW = 420;
  const bnrH = ovBounds.height;
  let bnrX;
  if (side === 'left') {
    bnrX = ovBounds.x - bnrW - 4;
  } else {
    bnrX = ovBounds.x + ovBounds.width + 4;
  }
  try {
    bannerWindow = new BrowserWindow({
      width: bnrW,
      height: bnrH,
      x: bnrX,
      y: ovBounds.y,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        backgroundThrottling: false,
      },
    });
    bannerWindow.setAlwaysOnTop(true, 'screen-saver');
    bannerWindow.setIgnoreMouseEvents(true, { forward: false });
    bannerWindow.loadFile(path.join(__dirname, 'banner.html'));
    bannerWindow.on('closed', () => { bannerWindow = null; });
    // Wait for the banner page to signal it's ready before sending data
    if (callback) {
      const readyHandler = () => { callback(); };
      ipcMain.once('banner-ready', readyHandler);
      // Safety timeout in case ready never fires
      setTimeout(() => {
        ipcMain.removeListener('banner-ready', readyHandler);
        callback();
      }, 1500);
    }
  } catch (e) {
    console.error('[banner] failed to create window:', e);
    bannerWindow = null;
  }
}

function positionBannerWindow(side) {
  if (!bannerWindow || bannerWindow.isDestroyed()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const ovBounds = overlayWindow.getBounds();
  const bnrW = 420;
  const bnrH = ovBounds.height;
  let bnrX;
  if (side === 'left') {
    bnrX = ovBounds.x - bnrW - 4;
  } else {
    bnrX = ovBounds.x + ovBounds.width + 4;
  }
  try {
    bannerWindow.setBounds({ x: bnrX, y: ovBounds.y, width: bnrW, height: bnrH }, false);
  } catch (e) {
    console.error('[banner] setBounds failed:', e);
  }
}

function determineBannerSide() {
  // Decide whether the banner goes left or right of the overlay.
  // If the overlay is on the right half of the screen, put banner on the left
  // (so it doesn't get clipped by the right monitor edge). Vice versa.
  if (!overlayWindow || overlayWindow.isDestroyed()) return 'right';
  try {
    const ovBounds = overlayWindow.getBounds();
    const { screen } = require('electron');
    const display = screen.getDisplayNearestPoint({ x: ovBounds.x, y: ovBounds.y });
    const screenBounds = display ? display.workArea : { x: 0, width: 1920 };
    const ovCenter = ovBounds.x + ovBounds.width / 2;
    const screenCenter = screenBounds.x + screenBounds.width / 2;
    // Also check if there's enough room on the preferred side
    const bannerWidth = 424; // 420 + 4px gap
    if (ovCenter > screenCenter) {
      // Overlay is on right half — prefer left
      if (ovBounds.x - bannerWidth >= screenBounds.x) return 'left';
      return 'right'; // no room on left, fall back
    } else {
      // Overlay is on left half — prefer right
      if (ovBounds.x + ovBounds.width + bannerWidth <= screenBounds.x + screenBounds.width) return 'right';
      return 'left'; // no room on right, fall back
    }
  } catch (e) {
    return 'right';
  }
}

// Overlay requests an external banner
ipcMain.on('show-external-banner', (event, data) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!data) return;
  if (_bannerHideTimer) { clearTimeout(_bannerHideTimer); _bannerHideTimer = null; }
  const side = determineBannerSide();
  data.side = side;
  _bannerPendingData = data;
  ensureBannerWindow(side, () => {
    if (!bannerWindow || bannerWindow.isDestroyed()) return;
    try {
      positionBannerWindow(side);
      bannerWindow.showInactive();
      bannerWindow.webContents.send('banner-data', _bannerPendingData);
      _bannerPendingData = null;
    } catch (e) {
      console.error('[banner] failed to show:', e);
    }
  });
});

// Banner animation finished — hide the window (keep it for reuse)
ipcMain.on('banner-done', () => {
  if (_bannerHideTimer) clearTimeout(_bannerHideTimer);
  _bannerHideTimer = setTimeout(() => {
    if (bannerWindow && !bannerWindow.isDestroyed()) {
      try { bannerWindow.hide(); } catch (e) {}
    }
  }, 100);
});

// ── Auto-update IPC ─────────────────────────────────────────────────────────
ipcMain.on('download-update', () => { if (autoUpdater) try { autoUpdater.downloadUpdate(); } catch (e) {} });
ipcMain.on('install-update', () => { if (autoUpdater) try { autoUpdater.quitAndInstall(false, true); } catch (e) {} });

// ── Settings export / import ────────────────────────────────────────────────
ipcMain.handle('export-settings', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export StreamFusion Settings',
    defaultPath: 'streamfusion-settings.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  return result.canceled ? null : result.filePath;
});
ipcMain.handle('import-settings', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import StreamFusion Settings',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  try { return fs.readFileSync(result.filePaths[0], 'utf8'); } catch (e) { return null; }
});
ipcMain.handle('write-export-file', async (event, filePath, data) => {
  try { fs.writeFileSync(filePath, data, 'utf8'); return true; } catch (e) { return false; }
});

ipcMain.on('open-log-folder', () => {
  try { shell.showItemInFolder(getLogPath()); } catch (e) {}
});

// ═══════════════════════════════════════════════════════════════════════════
// Promo overlay window — StreamFusion advertisement for OBS window capture.
// Lives separately from the main pop-out overlay so a streamer can have both
// open at once (their functional pop-out + the on-stream promo).
// ═══════════════════════════════════════════════════════════════════════════
function createPromoWindow(opts) {
  opts = opts || {};
  if (promoWindow && !promoWindow.isDestroyed()) {
    promoWindow.show();
    promoWindow.focus();
    return;
  }

  // Wider + taller than the pop-out. 520x720 gives enough room for the
  // bigger font and the CTA footer without clipping either section.
  var winOpts = {
    width: opts.width || 520,
    height: opts.height || 720,
    minWidth: 380,
    minHeight: 480,
    title: 'StreamFusion — Promo Overlay (for OBS capture)',
    frame: true,             // visible chrome so streamers can move/close it
    resizable: true,
    alwaysOnTop: false,       // not on top — it's meant to be captured, not watched
    skipTaskbar: false,
    backgroundColor: '#0b0b12',
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  };
  try {
    promoWindow = new BrowserWindow(winOpts);
  } catch (err) {
    console.error('[promo] window creation failed:', err);
    return;
  }

  promoWindow.loadFile(path.join(__dirname, 'promo.html')).catch(function(err) {
    console.error('[promo] loadFile failed:', err);
  });

  promoWindow.webContents.on('did-finish-load', function() {
    if (promoWindow && !promoWindow.isDestroyed()) {
      promoWindow.show();
      promoWindow.focus();
    }
    // Note: we rely on promo.html calling api.promoReady() to signal readiness
    // (same pattern as overlay). That forwards through ipcMain.on('promo-ready')
    // below which re-emits to the main renderer. Keeping one source of truth
    // means the initial stats push always fires after the DOM is actually set
    // up, not just after the HTML file finished loading.
  });

  // DevTools shortcut for the promo window too
  promoWindow.webContents.on('before-input-event', function(event, input) {
    if (input.type !== 'keyDown') return;
    var isF12 = input.key === 'F12';
    var isCtrlShiftI = input.control && input.shift && (input.key === 'I' || input.key === 'i');
    if (isF12 || isCtrlShiftI) {
      promoWindow.webContents.toggleDevTools({ mode: 'detach' });
      event.preventDefault();
    }
  });

  promoWindow.on('closed', function() {
    promoWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('promo-closed');
    }
  });

  promoWindow.webContents.setWindowOpenHandler(function(o) {
    shell.openExternal(o.url);
    return { action: 'deny' };
  });
}

ipcMain.handle('open-promo', function(event, opts) {
  try {
    createPromoWindow(opts || {});
    return true;
  } catch (err) {
    console.error('[promo] open-promo handler failed:', err);
    return false;
  }
});
ipcMain.on('close-promo', function() {
  if (promoWindow && !promoWindow.isDestroyed()) promoWindow.close();
});

// Forward renderer -> promo data stream. The main renderer fires the same
// chat/event/stats/live packets it fires at the pop-out overlay, but over a
// separate channel so the two windows stay independent.
ipcMain.on('promo-data', function(event, payload) {
  if (promoWindow && !promoWindow.isDestroyed()) {
    promoWindow.webContents.send('promo-data', payload);
  }
});

// Promo renderer signals it's ready for an initial snapshot
ipcMain.on('promo-ready', function() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('promo-ready');
  }
});

