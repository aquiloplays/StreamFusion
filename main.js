const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

// ── Patreon entitlement service ─────────────────────────────────────────────
// Optional sign-in; the app boots for everyone. Active Tier 2 / Tier 3
// supporters unlock Early Access (EA) features live. See patreon-auth.js.
const patreonAuth = require('./patreon-auth');

// ── Discord entitlement service (parallel path to EA) ───────────────────────
// Second way to unlock EA for users whose Patreon OAuth has edge cases
// (new-pledge sync lag, Apple private-relay email quirks where patron_status
// returns null). Patreon ↔ Discord integration assigns Tier 2 / Tier 3
// Patron roles automatically in aquilo.gg's Discord when someone pledges
// — checking those roles is a more reliable signal than hitting Patreon's
// /identity endpoint for edge-case accounts. Entitlement from EITHER path
// grants EA (renderer OR's them: S.hasEarlyAccess = patreon.entitled ||
// discord.entitled). See discord-auth.js.
const discordAuth = require('./discord-auth');

// ── OBS overlay server (EA-only) ────────────────────────────────────────────
// Local HTTP + SSE server that powers browser-source overlays (chat feed,
// alerts, shoutouts) for OBS. Starts on app launch and stays up regardless
// of entitlement so URLs are always reachable, but serves the "Early Access
// required" page for non-entitled users. See obs-server.js.
const obsServer = require('./obs-server');

// ── Discord integration (EA-only) ───────────────────────────────────────────
// Webhook helpers for stylized event posts + bot Gateway connection for
// observing Discord-side events (member/voice joins, messages in a channel).
// Gated behind the EA entitlement check in main.js's setup path.
const discordBot = require('./discord-bot');
const rotationRelay = require('./rotation-relay-client');

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
  // Silent updates: download in the background as soon as an update is
  // detected, then apply on next app quit. The user never sees a prompt
  // or an installer UI — they just close SF and reopen to the new
  // version. This matches the behavior most desktop apps (Slack,
  // Discord, VS Code) ship by default and was the top 1.4.5 ask.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // 1.5.1: beta channel detection. The build-beta script produces a
  // separate "StreamFusion Beta" variant with a distinct appId that
  // installs alongside the main app. At runtime, check whether we're
  // that variant (by productName / app name / package.json `name`)
  // and pin the auto-updater to the 'beta' channel — makes it pull
  // beta.yml instead of latest.yml. Main SF installs stay on the
  // stable channel, so beta users don't accidentally "demote" to a
  // production release.
  try {
    var pname = app.getName() || '';
    if (pname.toLowerCase().indexOf('beta') !== -1 ||
        (app.getPath('exe') || '').toLowerCase().indexOf('beta') !== -1) {
      autoUpdater.channel = 'beta';
    }
  } catch (e) {}
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

// ── StreamFusion icon generator ──────────────────────────────────────────────
// The drawing code lives in icon-gen.js so the same source of truth drives:
//   - runtime tray + window icons (built fresh on app start via buildSFIcon)
//   - build-time assets/icon.ico + assets/icon.png (via scripts/gen-icon.js,
//     wired as the prebuild npm hook)
// This prevents the 1.4.5-era drift where the tray got the new branding but
// the taskbar + desktop shortcuts stayed on the old .ico.
const { buildSFIcon, PALETTES } = require('./icon-gen');

// 1.5.1: single source of truth for "are we the beta variant?".
// Check both app.getName() (driven by build-beta.js's extraMetadata
// rewrite of package.json name → streamfusion-beta) AND the exe path
// (driven by productName → "StreamFusion Beta" install folder). Two
// signals so a rename or manual copy of the exe doesn't mis-classify.
// Used by: icon palette, window title, in-app BETA badge, Tier 3 gate.
function _isBetaVariant() {
  try {
    var n = (app.getName() || '').toLowerCase();
    if (n.indexOf('beta') !== -1) return true;
    if ((app.getPath('exe') || '').toLowerCase().indexOf('beta') !== -1) return true;
  } catch (e) {}
  return false;
}

function _sfIconPalette() {
  return _isBetaVariant() ? PALETTES.beta : PALETTES.stable;
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
// Set true once electron-updater fires update-downloaded for the current
// session. Drives the close-dialog default (becomes "Install & Restart"
// when pending) and the tray menu entry. Cleared after install fires.
let _pendingUpdateVersion = null;

// Rebuilds the tray context menu so it reflects the current pending-update
// state. Called from the tray-create path AND whenever the pending state
// changes (download arrives / install fires) so the menu stays accurate
// without forcing a tray-icon recreation.
function _rebuildTrayMenu() {
  if (!tray || tray.isDestroyed?.()) return;
  const items = [
    { label: 'StreamFusion v' + app.getVersion(), enabled: false },
    { type: 'separator' },
    { label: 'Show StreamFusion', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
  ];
  if (_pendingUpdateVersion) {
    items.push({ type: 'separator' });
    items.push({
      label: 'Install Update v' + _pendingUpdateVersion + ' & Restart',
      click: () => {
        try { logToFile('UPDATE', 'tray: user clicked Install Update Now'); } catch (e) {}
        ipcMain.emit('install-update');
      },
    });
  }
  items.push({ type: 'separator' });
  items.push({
    label: 'Quit',
    click: () => { isQuitting = true; app.quit(); },
  });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}
let overlayHotkeyAccel = 'CommandOrControl+Shift+L';
// Mouse4/Mouse5 cannot be registered via Electron globalShortcut. When the
// user picks one of those, we record it here and the PowerShell input poller
// (further down) watches the corresponding XButton state and emits the
// toggle event itself.
let overlayHotkeyMouseButton = null; // null | 'Mouse4' | 'Mouse5'
// 1.5.1: user-configurable mouse-side-button bindings that fire hotbar
// SB actions. Keys: 'Mouse4' / 'Mouse5'. Values: integer hotbar slot
// index, or null to leave unbound. Keep separate from the overlay
// toggle binding above — both can be live simultaneously (e.g. M4 =
// overlay toggle, M5 = hotbar slot 0) as long as they don't collide.
let mouseHotbarBindings = { Mouse4: null, Mouse5: null };
function getMouseBindingsPath() { return path.join(app.getPath('userData'), 'mouse-bindings.json'); }
function saveMouseBindings() {
  try { fs.writeFileSync(getMouseBindingsPath(), JSON.stringify(mouseHotbarBindings)); } catch (e) {}
}
function loadMouseBindings() {
  try {
    var raw = fs.readFileSync(getMouseBindingsPath(), 'utf8');
    var d = JSON.parse(raw);
    if (d && typeof d === 'object') {
      if (d.Mouse4 == null || typeof d.Mouse4 === 'number') mouseHotbarBindings.Mouse4 = d.Mouse4;
      if (d.Mouse5 == null || typeof d.Mouse5 === 'number') mouseHotbarBindings.Mouse5 = d.Mouse5;
    }
  } catch (e) {}
}
loadMouseBindings();
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
            _dispatchMouseSideButton('Mouse4');
          }
        } else if (line === 'M4U') {
          mouse4WasDown = false;
        } else if (line === 'M5D') {
          if (!mouse5WasDown) {
            mouse5WasDown = true;
            _dispatchMouseSideButton('Mouse5');
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
// When a mouse side button press is detected, route it to the
// appropriate target(s). A single button can drive the overlay-toggle
// hotkey AND a hotbar slot simultaneously if the user has both
// assigned — for streamers on 2-button-only mice, that's often the
// pragmatic config. No-op when the window isn't available yet.
function _dispatchMouseSideButton(btn) {
  try {
    // (a) Overlay toggle — fires when the user has set this mouse
    // button as the overlay-interact hotkey.
    if (overlayHotkeyMouseButton === btn && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay-toggle-interact');
    }
    // (b) Hotbar slot — fires when the user bound this button to an
    // SB action via Settings. The main renderer owns the SB websocket,
    // so we forward through mainWindow's overlay-fire-hotbar listener
    // (same path the pop-out uses for its own button clicks).
    var slot = mouseHotbarBindings[btn];
    if (typeof slot === 'number' && slot >= 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('overlay-fire-hotbar', slot);
    }
  } catch (e) { console.error('[mouse-dispatch]', e); }
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
    const iconBuf = buildSFIcon(256, _sfIconPalette());
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
    // Taskbar hover / Alt+Tab label. Title bar inside the app is a
    // custom HTML element (see index.html .titlebar) that reads the
    // same signal via electronAPI.isBeta().
    title: _isBetaVariant() ? 'StreamFusion BETA' : 'StreamFusion',
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
      // When a downloaded update is sitting in the wings, change the
      // default action so a user clicking X actually gets the update
      // installed. Previously the dialog defaulted to "Minimize to Tray"
      // which kept the app alive → autoInstallOnAppQuit never fired →
      // user reopened to find the same old version. Now the dialog
      // primary button is "Install Update & Restart" and fires the same
      // silent quitAndInstall(true, true) the toolbar Update Now button
      // uses.
      var hasPendingUpdate = !!_pendingUpdateVersion;
      var dialogOpts = hasPendingUpdate
        ? {
            type: 'question',
            buttons: ['Install Update v' + _pendingUpdateVersion + ' & Restart', 'Minimize to Tray', 'Exit Without Updating', 'Cancel'],
            defaultId: 0,
            cancelId: 3,
            title: 'StreamFusion',
            message: 'A StreamFusion update is ready.',
            detail: 'Install + restart now (silent, ~10 seconds), keep the app running in the tray, or exit and apply the update on next launch.',
          }
        : {
            type: 'question',
            buttons: ['Minimize to Tray', 'Exit StreamFusion', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
            title: 'StreamFusion',
            message: 'What would you like to do?',
            detail: 'Minimize keeps StreamFusion running in the background.',
          };
      dialog.showMessageBox(mainWindow, dialogOpts).then(({ response }) => {
        if (hasPendingUpdate) {
          if (response === 0) {
            // Install & Restart — fire the same path the toolbar button uses.
            logToFile('UPDATE', 'close-dialog: user chose Install & Restart — invoking install-update path');
            ipcMain.emit('install-update');
          } else if (response === 1) {
            // Minimize to Tray (update stays pending — autoInstallOnAppQuit
            // will still fire on a real exit later).
            mainWindow.hide();
            if (tray && process.platform === 'win32') {
              tray.displayBalloon({ iconType: 'info', title: 'StreamFusion', content: 'Update v' + _pendingUpdateVersion + ' will install when you fully exit.' });
            }
          } else if (response === 2) {
            // Exit without updating — let autoInstallOnAppQuit fire on quit.
            isQuitting = true;
            app.quit();
          }
          // response === 3 → Cancel, do nothing
        } else {
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
        }
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
    const iconBuf = buildSFIcon(256, _sfIconPalette());
    trayIcon = nativeImage.createFromBuffer(iconBuf);
    // Resize to 16x16 for crisp tray rendering on Windows
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('StreamFusion v' + app.getVersion() + ' — Running');

  // Tray menu is rebuilt whenever a downloaded update arrives so the
  // "Install Update Now" item can appear without restarting the app.
  _rebuildTrayMenu();
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
    // 1.5.1 fix: a recurring user report was "double-clicked the SF
    // shortcut while SF was minimized to tray, nothing happened, had
    // to use the tray icon to reopen." Root cause was two issues
    // stacked:
    //   1. Windows focus-stealing prevention can silently no-op a
    //      mainWindow.focus() call from a background process. The
    //      setAlwaysOnTop(true) + focus + setAlwaysOnTop(false) dance
    //      is the canonical Electron workaround.
    //   2. If the window was hidden (close-to-tray path), show()
    //      needs to run BEFORE focus() — otherwise focus targets a
    //      hidden window and the title bar briefly flashes but
    //      nothing visible happens.
    // Plus diagnostic logging so future regressions leave a trace.
    logToFile('WINDOW', 'second-instance fired; mainWindow=' + !!mainWindow + ' destroyed=' + (mainWindow && mainWindow.isDestroyed()));
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.setAlwaysOnTop(true);
        mainWindow.focus();
        // Release always-on-top a tick later so the window surfaces
        // cleanly without stealing focus from OBS / games permanently.
        setTimeout(function() {
          try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false); } catch (e) {}
        }, 150);
      } catch (e) {
        logToFile('WINDOW-ERR', 'second-instance surface failed: ' + (e && e.message));
      }
    } else {
      try { createWindow(); } catch (e) { logToFile('WINDOW-ERR', 'recreate failed: ' + (e && e.message)); }
    }
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createTray();
  createWindow();
  startCtrlPoller();

  // Patreon + Discord entitlement services. Both are optional sign-ins;
  // the app boots for everyone. Users get EA features if EITHER path
  // reports entitled. Register IPC handlers and point both at the main
  // window so entitlement changes reach the renderer. Kick off a
  // launch-time check on a small delay so the renderer has had time to
  // wire up its listeners. If the user is already signed in to either,
  // each service starts its own hourly re-verification loop.
  patreonAuth.setMainWindow(mainWindow);
  patreonAuth.registerIpcHandlers();
  discordAuth.setMainWindow(mainWindow);
  discordAuth.registerIpcHandlers();

  // OBS overlay server comes up alongside the main window. It always
  // listens (so the streamer can bookmark the URLs without worrying about
  // whether SF is "ready"), but it returns the gated page if the user
  // isn't an active Tier 2/3 supporter.
  obsServer.startServer().then(function(ok) {
    if (!ok) logToFile('OBS-SERVER', 'failed to start on default port');
  }).catch(function(e) {
    logToFile('OBS-SERVER-ERR', 'start threw: ' + (e && e.message));
  });

  // Union-of-sources entitlement gate. Either Patreon OR Discord says
  // entitled ⇒ user is entitled. Track the last emitted state from each
  // source and recompute the combined flag on every change. Drives:
  //   - obs-server's gated-page flag
  //   - auto-disconnect of the Discord bot when BOTH sources lose access
  var _lastPatreonEntitled = false;
  var _lastDiscordEntitled = false;
  function _syncCombinedEntitlement() {
    var entitled = _lastPatreonEntitled || _lastDiscordEntitled;
    try { obsServer.setEntitled(entitled); } catch (e) {}
    if (!entitled) {
      // Neither path is entitled — drop the discord-bot Gateway connection.
      // When either source re-activates, the renderer re-issues the
      // connect command via its existing IPC flow.
      try { discordBot.disconnectBot(); } catch (e) {}
    }
  }
  patreonAuth.onEntitlementChange(function(state) {
    _lastPatreonEntitled = !!(state && state.entitled);
    _syncCombinedEntitlement();
  });
  discordAuth.onEntitlementChange(function(state) {
    _lastDiscordEntitled = !!(state && state.entitled);
    _syncCombinedEntitlement();
  });
  discordBot.setMainWindow(mainWindow);

  // Rotation Relay — subscribes to song events from the streamer's Rotation
  // widget and forwards them to the events tab + chat overlay. No-op until
  // the streamer pastes a roomKey in Settings → Rotation Widget. Universal
  // (free for everyone using both products) — not gated on entitlement.
  rotationRelay.setMainWindow(mainWindow);
  try { rotationRelay.start(); }
  catch (e) { logToFile('ROTATION-RELAY', 'start threw: ' + (e && e.message)); }

  setTimeout(function() {
    patreonAuth.getEntitlement().then(function(state) {
      if (state && state.signedIn) patreonAuth.startRuntimeChecks();
    }).catch(function(e) {
      logToFile('AUTH-ERR', 'launch patreon entitlement check failed: ' + (e && e.message));
    });
    discordAuth.getEntitlement().then(function(state) {
      if (state && state.signedIn) discordAuth.startRuntimeChecks();
    }).catch(function(e) {
      logToFile('AUTH-ERR', 'launch discord entitlement check failed: ' + (e && e.message));
    });
  }, 2500);

  // Check for updates (non-blocking). Verbose logging through every stage
  // so 1.4.7+ installs that fail to complete leave a breadcrumb in the
  // log file — 1.4.4/1.4.5 installs that silently failed left no trace.
  if (autoUpdater) {
    autoUpdater.on('checking-for-update', () => {
      logToFile('UPDATE', 'checking for updates…');
    });
    autoUpdater.on('update-not-available', (info) => {
      logToFile('UPDATE', 'no update available (current ' + app.getVersion() + ')');
    });
    autoUpdater.on('update-available', (info) => {
      logToFile('UPDATE', 'update AVAILABLE: ' + (info && info.version) + ' (current ' + app.getVersion() + ') — autoDownload kicked off');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-available', { version: info.version });
      }
    });
    autoUpdater.on('download-progress', (p) => {
      if (p && p.percent != null) logToFile('UPDATE', 'download ' + Math.round(p.percent) + '% (' + Math.round((p.bytesPerSecond||0)/1024) + ' KB/s)');
    });
    autoUpdater.on('update-downloaded', (info) => {
      _pendingUpdateVersion = (info && info.version) || 'pending';
      logToFile('UPDATE', 'update DOWNLOADED: ' + _pendingUpdateVersion + ' — will auto-install on next app quit, OR sooner if user clicks Update Now');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-downloaded', { version: info.version });
      }
      // Refresh tray menu so the "Install Update Now" item appears
      // without waiting for a tray event.
      try { _rebuildTrayMenu(); } catch (e) {}
    });
    autoUpdater.on('error', (err) => {
      logToFile('UPDATE-ERR', 'autoUpdater error: ' + (err && err.stack || err));
    });
    // Beta installs publish to a PRIVATE repo (aquiloplays/StreamFusion-beta),
    // so electron-updater needs a PAT with `repo` read scope to fetch the
    // manifest. v1.5.5 onwards: SF asks the Cloudflare Worker for that PAT
    // on every launch — the Worker verifies the user is currently a Tier 3
    // patron (via their Patreon access token) and returns GITHUB_BETA_TOKEN.
    // SF caches the returned PAT to userData/beta-updater-token.txt so:
    //   - subsequent launches work even when the Worker is unreachable
    //     (network down, deploy in progress, etc.)
    //   - manual PAT-file management is no longer required for new patrons
    //   - existing patrons with a hand-managed PAT keep working unchanged
    //
    // On an explicit 403 from the Worker (patron demoted below Tier 3) the
    // cached PAT is deleted so they lose beta-update access next launch.
    // On a network/5xx error the cached PAT is preserved.
    //
    // Stable installs skip this whole flow.
    var _skipAutoUpdate = false;
    var _betaPatPath = path.join(app.getPath('userData'), 'beta-updater-token.txt');
    var WORKER_BASE = 'https://streamfusion-patreon-proxy.bisherclay.workers.dev';

    function _setBetaFeed(token) {
      autoUpdater.setFeedURL({
        provider: 'github',
        owner:    'aquiloplays',
        repo:     'StreamFusion-beta',
        private:  true,
        token:    token,
        channel:  'beta'
      });
    }

    // Fetches a fresh PAT from the Worker, writes it to disk, returns it.
    // Resolves with { ok, token, status } so the caller can decide whether
    // to fall back to the cached value or wipe the cache outright.
    async function _fetchBetaPatFromWorker() {
      var pat = patreonAuth.getRawAccessToken && patreonAuth.getRawAccessToken();
      if (!pat) return { ok: false, status: 'no-patreon-token' };
      try {
        var resp = await fetch(WORKER_BASE + '/beta-updater-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patreonAccessToken: pat })
        });
        var body = null;
        try { body = await resp.json(); } catch (e) {}
        if (resp.ok && body && body.token) {
          try {
            fs.writeFileSync(_betaPatPath, body.token, { encoding: 'utf-8', mode: 0o600 });
          } catch (writeErr) {
            logToFile('UPDATE-ERR', 'beta: failed to write fetched PAT to disk: ' + (writeErr && writeErr.message));
          }
          logToFile('UPDATE', 'beta: Worker vended a fresh PAT (tier=' + (body.tier || '?') + ') and cached to disk');
          return { ok: true, status: 'fresh', token: body.token };
        }
        if (resp.status === 403) {
          // Patron demoted — wipe cached PAT so they don't keep using a stale one.
          try { if (fs.existsSync(_betaPatPath)) fs.unlinkSync(_betaPatPath); } catch (e) {}
          logToFile('UPDATE', 'beta: Worker said 403 (' + (body && body.error) + '); wiped cached PAT — auto-update disabled until re-entitled');
          return { ok: false, status: '403', error: (body && body.error) || 'forbidden' };
        }
        logToFile('UPDATE-ERR', 'beta: Worker returned ' + resp.status + ' (' + (body && body.error) + ') — falling back to cached PAT');
        return { ok: false, status: 'http-' + resp.status };
      } catch (e) {
        logToFile('UPDATE-ERR', 'beta: Worker fetch threw (' + (e && e.message) + ') — falling back to cached PAT');
        return { ok: false, status: 'network-error' };
      }
    }

    function _readCachedBetaPat() {
      try {
        if (!fs.existsSync(_betaPatPath)) return null;
        var t = fs.readFileSync(_betaPatPath, 'utf-8').trim();
        return t || null;
      } catch (e) { return null; }
    }

    async function _setupBetaFeedAndCheck() {
      if (!_isBetaVariant()) return;   // stable: nothing to do
      // Worker fetch first. On 403 the cache is wiped inside the helper.
      var fresh = await _fetchBetaPatFromWorker();
      var token = null;
      if (fresh.ok && fresh.token) {
        token = fresh.token;
      } else if (fresh.status !== '403') {
        // Network / Worker / signed-out: try the cached PAT.
        token = _readCachedBetaPat();
        if (token) logToFile('UPDATE', 'beta: using cached PAT from disk (Worker unavailable: ' + fresh.status + ')');
      }
      if (!token) {
        _skipAutoUpdate = true;
        logToFile('UPDATE', 'beta: no PAT available (Worker=' + fresh.status + ', cache=empty) — auto-update disabled');
        return;
      }
      try { _setBetaFeed(token); }
      catch (e) {
        logToFile('UPDATE-ERR', 'beta: setFeedURL threw: ' + (e && e.message));
        _skipAutoUpdate = true;
        return;
      }
      logToFile('UPDATE', 'beta: feed pinned to StreamFusion-beta with ' + (fresh.ok ? 'fresh Worker-vended' : 'cached on-disk') + ' PAT');
    }

    setTimeout(() => {
      _setupBetaFeedAndCheck()
        .catch(function(e) { logToFile('UPDATE-ERR', 'beta setup threw: ' + (e && e.message)); _skipAutoUpdate = true; })
        .finally(function() {
          if (_skipAutoUpdate) { logToFile('UPDATE', 'beta: checkForUpdates skipped (no PAT)'); return; }
          try { autoUpdater.checkForUpdates(); }
          catch (e) { logToFile('UPDATE-ERR', 'checkForUpdates threw: ' + (e && e.message)); }
        });
    }, 8000);
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
  try { discordAuth.stopRuntimeChecks(); } catch (e) {}
  try { obsServer.stopServer(); } catch (e) {}
  try { discordBot.disconnectBot(); } catch (e) {}
  try { rotationRelay.stop(); } catch (e) {}
});

// ── IPC handlers (called from renderer via preload) ──────────────────────────
ipcMain.handle('app-version', () => app.getVersion());
// Renderer asks this on boot to decide whether to render the BETA
// badge + "StreamFusion BETA" wordmark + any beta-only UI affordances.
ipcMain.handle('is-beta', () => _isBetaVariant());

// ── OBS overlay IPC ─────────────────────────────────────────────────────────
// The renderer is the single source of truth for chat/events/shoutouts —
// it owns the Streamer.bot + Tikfinity WebSockets. When it receives a
// message or the streamer clicks a shoutout, it forwards the payload
// here, and we fan it out to every connected OBS browser source.
ipcMain.on('obs-broadcast-chat', function(event, data) {
  // Chat messages fan out to BOTH the horizontal chat overlay AND the
  // vertical bar overlay. Vertical decides for itself (via its config)
  // whether chat rows should display; no harm in forwarding always.
  try { obsServer.broadcast('chat', data, ['chat', 'vertical']); } catch (e) {}
});
ipcMain.on('obs-broadcast-alert', function(event, data) {
  // Alerts fan out to the alerts banner, the vertical bar, AND the chat
  // overlay. The chat overlay decides for itself (via its showEvents +
  // showGiftAnimations config flags) whether to render them as an
  // inline events row, as a full-overlay floating gift animation, or
  // ignore them entirely.
  try { obsServer.broadcast('alert', data, ['alerts', 'vertical', 'chat']); } catch (e) {}
});
ipcMain.on('obs-broadcast-shoutout', function(event, data) {
  try { obsServer.broadcast('shoutout', data, 'shoutout'); } catch (e) {}
});

// ── Rotation Relay IPC ──────────────────────────────────────────────────────
// The renderer drives lifecycle (set room key, toggle on/off) and listens for
// events on the 'rotation-event' channel so the events tab can render them.
// Status changes flow back via 'rotation-relay-status'. The
// 'rotation-relay-broadcast' channel is the relay client's nudge to the
// renderer to rebroadcast as a chat-overlay system row — handled there
// because the renderer holds canonical chat-overlay broadcast logic.
ipcMain.handle('rotation-relay-get-status', function() {
  try { return rotationRelay.getStatus(); }
  catch (e) { return { enabled: false, connected: false, reason: 'error' }; }
});
ipcMain.handle('rotation-relay-set-config', function(event, patch) {
  try { return rotationRelay.setConfig(patch || {}); }
  catch (e) { return { enabled: false, connected: false, reason: 'error' }; }
});
ipcMain.handle('rotation-relay-stop', function() {
  try { rotationRelay.stop(); return rotationRelay.getStatus(); }
  catch (e) { return { enabled: false, connected: false, reason: 'error' }; }
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

// ── Discord IPC ─────────────────────────────────────────────────────────────
// Webhook POST — used for stylized event embeds, records, and recap. Returns
// { ok, status, id } so the caller can remember the message id for later
// delete-and-repost flows (the records feature does this).
ipcMain.handle('discord-webhook-post', function(event, payload) {
  if (!payload || !payload.url) return Promise.resolve({ ok: false, error: 'no_url' });
  return discordBot.postWebhook(payload.url, payload.body || {});
});
// Webhook DELETE — removes a previously posted message by id. Records use
// this to wipe the old record embed before posting the new one.
ipcMain.handle('discord-webhook-delete', function(event, payload) {
  if (!payload || !payload.url || !payload.messageId) return Promise.resolve({ ok: false, error: 'missing' });
  return discordBot.deleteWebhookMessage(payload.url, payload.messageId);
});
// Bot lifecycle. The renderer calls connect whenever the token changes or
// the user toggles the bot on; disconnect when they toggle off or lose EA.
ipcMain.handle('discord-bot-connect', function(event, cfg) {
  return discordBot.connectBot(cfg || {});
});
ipcMain.handle('discord-bot-disconnect', function() {
  return discordBot.disconnectBot();
});
ipcMain.handle('discord-bot-status', function() {
  return discordBot.getBotStatus();
});
// Shared-bot (SSE to hosted bot service). We look up the user's Patreon
// access token here rather than let the renderer hand us one — the token
// is intentionally kept out of the renderer for the same reason the
// refresh token is.
ipcMain.handle('shared-bot-connect', function(event, cfg) {
  cfg = cfg || {};
  var token = patreonAuth.getRawAccessToken();
  if (!token) return Promise.resolve({ ok: false, reason: 'not_signed_in' });
  return discordBot.sharedBotConnect({
    botServiceUrl: cfg.botServiceUrl,
    guildId:       cfg.guildId,
    accessToken:   token
  });
});
ipcMain.handle('shared-bot-disconnect', function() {
  return discordBot.sharedBotDisconnect();
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

// Twitch game name — fallback for when Streamer.bot's GetBroadcaster
// response doesn't include game/category fields (happens on some SB
// versions or when the streamer goes live *after* SB was already
// connected). decapi returns plain text: the game name when the user
// is live, "User is not live" or similar when offline. We parse
// anything that doesn't look like one of those not-live strings as a
// game name; noisy-string heuristics keep us from labelling offline
// responses as a category.
ipcMain.handle('fetch-twitch-game', async (event, login) => {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'decapi.me',
      path: '/twitch/game/' + encodeURIComponent(login),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StreamFusion)', 'Accept': 'text/plain' }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        var txt = String(data).trim();
        if (!txt) return resolve(null);
        // decapi returns one of these when not live — skip them
        if (/not (live|found|streaming)|^404|no stream|offline/i.test(txt)) return resolve(null);
        // Typical live response is just the game name, e.g. "Palworld"
        if (txt.length > 120) return resolve(null); // sanity cap
        resolve(txt);
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

  // Restore saved bounds from previous session. 1.5.1 fix: previous
  // logic guarded the size fields with `if (!opts.width)` which always
  // skipped restore because the renderer's toggleOverlay sends the
  // current preset's width/height on every open. That made saved size
  // effectively ignored — the window snapped back to the preset
  // dimensions every time the streamer reopened, even if they'd
  // resized it. Now saved bounds (size + position) win by default.
  //
  // When the user explicitly picks a new preset from the pop-out's
  // size selector, the renderer sets opts.forcePreset = true to
  // signal "I'm intentionally resetting to this size, don't restore".
  var saved = loadOverlayBounds();
  if (saved) {
    if (opts.x == null) opts.x = saved.x;
    if (opts.y == null) opts.y = saved.y;
    if (!opts.forcePreset) {
      opts.width  = saved.width;
      opts.height = saved.height;
    }
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

// 1.5.1: mouse side-button → hotbar-slot bindings. Each call replaces
// the binding for a single button. Payload shape:
//   { button: 'Mouse4' | 'Mouse5', slot: number | null }
// slot = null unbinds. Persists to disk so the binding survives
// restarts. Returns the full updated map so the renderer can reflect
// state in its UI.
ipcMain.handle('mouse-set-hotbar-binding', (event, payload) => {
  if (!payload || !payload.button) return { ok: false, error: 'missing_button' };
  if (payload.button !== 'Mouse4' && payload.button !== 'Mouse5') return { ok: false, error: 'invalid_button' };
  if (payload.slot == null) {
    mouseHotbarBindings[payload.button] = null;
  } else {
    var n = parseInt(payload.slot, 10);
    if (isNaN(n) || n < 0) return { ok: false, error: 'invalid_slot' };
    mouseHotbarBindings[payload.button] = n;
  }
  saveMouseBindings();
  return { ok: true, bindings: mouseHotbarBindings };
});
ipcMain.handle('mouse-get-hotbar-bindings', () => mouseHotbarBindings);

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
ipcMain.on('download-update', () => {
  if (!autoUpdater) return;
  logToFile('UPDATE', 'download-update IPC received');
  try { autoUpdater.downloadUpdate(); } catch (e) { logToFile('UPDATE-ERR', 'downloadUpdate threw: ' + (e && e.message)); }
});
// install-update IPC: silent install + force relaunch. The 1.4.4/1.4.5
// flow used quitAndInstall(false, true) which shows the NSIS installer
// UI — if that window landed behind another app (common on busy streaming
// setups) the user never saw it, the install never completed, and the
// app never relaunched. Clicking "Install & Restart" looked like the app
// just died. Silent install (`isSilent: true`) passes /S to NSIS so the
// install happens without UI, and `isForceRunAfter: true` launches the
// fresh app automatically when the installer finishes. This is the same
// flow Slack/Discord/VS Code use for their auto-updates.
ipcMain.on('install-update', () => {
  if (!autoUpdater) { logToFile('UPDATE-ERR', 'install-update IPC but autoUpdater missing'); return; }
  logToFile('UPDATE', 'install-update IPC received — tearing down child processes then calling quitAndInstall(silent=true, forceRunAfter=true)');
  // Mark quitting BEFORE teardown so the main-window close handler doesn't
  // pop the "Minimize to Tray?" dialog and trap us. Manually shut down
  // every long-lived child so electron-updater's installer-spawn isn't
  // blocked by an open file lock or socket on the SF binary.
  isQuitting = true;
  try { obsServer.stopServer(); }    catch (e) { logToFile('UPDATE-ERR', 'obsServer.stopServer threw: ' + (e && e.message)); }
  try { discordBot.disconnectBot(); } catch (e) { logToFile('UPDATE-ERR', 'discordBot.disconnectBot threw: ' + (e && e.message)); }
  try { patreonAuth.stopRuntimeChecks(); } catch (e) {}
  try { discordAuth.stopRuntimeChecks(); } catch (e) {}
  try { globalShortcut.unregisterAll(); } catch (e) {}
  // quitAndInstall is a no-op if the update isn't downloaded yet, but
  // we surface the case to the log so we can diagnose post-mortem.
  try {
    autoUpdater.quitAndInstall(true, true);
    logToFile('UPDATE', 'quitAndInstall returned — installer should be spawning. App should exit shortly.');
  } catch (e) {
    logToFile('UPDATE-ERR', 'quitAndInstall threw: ' + (e && e.message));
    // If the spawn failed, restore isQuitting so the app keeps running
    // and surface the failure to the renderer.
    isQuitting = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-install-failed', { error: String(e && e.message || e) });
    }
  }
});

// Renderer tells main: an update has been downloaded. Cached so the
// main-window close handler can change its dialog default to "Install
// Update & Restart" instead of "Minimize to Tray". Without this, users
// who click X expecting an install end up minimised-to-tray and the
// app never quits → autoInstallOnAppQuit never fires → no update.
ipcMain.on('update-downloaded-notify', (event, version) => {
  _pendingUpdateVersion = version || _pendingUpdateVersion || 'pending';
  logToFile('UPDATE', 'renderer-notify: update v' + _pendingUpdateVersion + ' marked as ready — close-dialog default switched to Install & Restart');
  try { _rebuildTrayMenu(); } catch (e) {}
});

// Manual "Check for updates" button in Settings → About → Updates. Lets
// users trigger an out-of-cycle check instead of waiting for the
// automatic periodic one. Resolves with a status string the renderer can
// render in place ("checking…", "up to date", "downloading update…").
ipcMain.handle('check-for-updates', async () => {
  if (!autoUpdater) return { ok: false, status: 'no-updater', error: 'autoUpdater not available' };
  logToFile('UPDATE', 'manual check-for-updates IPC received');
  try {
    const res = await autoUpdater.checkForUpdates();
    const info = res && res.updateInfo;
    const curVer = app.getVersion();
    // electron-updater compares versions internally; if .updateInfo.version
    // equals the running app version, no update is available.
    if (!info || !info.version || info.version === curVer) {
      return { ok: true, status: 'up-to-date', currentVersion: curVer };
    }
    return { ok: true, status: 'update-available', currentVersion: curVer, latestVersion: info.version };
  } catch (e) {
    logToFile('UPDATE-ERR', 'manual check threw: ' + (e && e.message));
    return { ok: false, status: 'error', error: String(e && e.message || e) };
  }
});

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

