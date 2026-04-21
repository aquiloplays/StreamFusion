#!/usr/bin/env node
// Build a "StreamFusion Beta" variant. Installs alongside the main
// StreamFusion (different appId = different Windows identity), so you
// can run both and test pre-release changes without touching your
// day-to-day install. Its auto-updater is pinned to the 'beta' channel
// so it pulls ONLY from GitHub pre-release tags (e.g. v1.6.0-beta.1),
// leaving production users on the main channel undisturbed.
//
// Usage: npm run build:beta
//
// Output: dist-beta/StreamFusion-Beta-Setup-<ver>.exe + portable
//
// Version stamping: if package.json's version is already a semver
// prerelease (e.g. 1.5.1-beta.2), it's used as-is. Otherwise we
// append `-beta.0` so the next beta-only release-tag can take over.
// Release flow:
//   1. `npm run build:beta`
//   2. Upload assets to a GitHub release tagged e.g. v1.6.0-beta.1
//      and mark it as a pre-release in the GitHub UI.
//   3. Upload `beta.yml` (produced alongside the installer) as an
//      asset too — that's the manifest the beta auto-updater reads.

'use strict';

const path   = require('path');
const fs     = require('fs');
const builder = require('electron-builder');
const { buildRawIcon, encodePNG, buildIco, PALETTES } = require('../icon-gen');

const REPO_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

// Produce a semver-valid pre-release version string from whatever is in
// package.json. electron-updater treats anything with `-beta.N` as a
// pre-release channel candidate.
function betaVersion(v) {
  v = String(v || '0.0.0');
  return /-beta\.\d+$/.test(v) ? v : (v + '-beta.0');
}

const version = betaVersion(pkg.version);
console.log('[build-beta] building StreamFusion Beta v' + version);

// Generate BETA icon assets in parallel to the stable ones. The beta
// build gets a distinct amber/orange palette (see icon-gen.PALETTES.beta)
// so users running both variants side-by-side can tell them apart at a
// glance on the taskbar, tray, desktop shortcut, and Alt+Tab switcher.
// We also run the stable prebuild so assets/icon.ico stays fresh for
// the next normal build — this script doesn't assume it ran most
// recently.
try {
  require('./gen-icon');   // regenerates assets/icon.ico + assets/icon.png (stable)
} catch (e) { console.warn('[build-beta] stable gen-icon failed:', e.message); }

const ASSETS = path.join(REPO_ROOT, 'assets');
try {
  const bigRaw = buildRawIcon(512, PALETTES.beta);
  const bigPng = encodePNG(bigRaw.W, bigRaw.H, bigRaw.px);
  fs.writeFileSync(path.join(ASSETS, 'icon-beta.png'), bigPng);
  console.log('[build-beta] wrote assets/icon-beta.png (' + bigPng.length + ' bytes, 512x512, beta palette)');

  const betaIco = buildIco([16, 24, 32, 48, 64, 128, 256], PALETTES.beta);
  fs.writeFileSync(path.join(ASSETS, 'icon-beta.ico'), betaIco);
  console.log('[build-beta] wrote assets/icon-beta.ico (' + betaIco.length + ' bytes, 7 sizes, beta palette)');
} catch (e) {
  console.error('[build-beta] failed to generate beta icons:', e);
  process.exit(1);
}

// Hoist-level overrides: appId, productName, NSIS shortcut/artifact
// naming, portable artifact name, output dir. Everything else is
// inherited from package.json's build config so the beta build stays
// structurally identical to production.
const config = {
  appId:        'gg.aquilo.streamfusion-beta',
  productName:  'StreamFusion Beta',
  extraMetadata: {
    name: 'streamfusion-beta',
    version: version
  },
  directories: {
    output: 'dist-beta'
  },
  // Point electron-builder at the amber/orange beta icons generated
  // above. These drive: the taskbar icon, Start Menu shortcut icon,
  // desktop shortcut icon, Alt+Tab preview, and the NSIS installer
  // header. Runtime-drawn surfaces (tray, title bar) switch to the
  // beta palette via main.js's PALETTES.beta detection.
  win: {
    icon: 'assets/icon-beta.ico'
  },
  mac: {
    icon: 'assets/icon-beta.png'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'StreamFusion Beta',
    installerHeaderIcon: 'assets/icon-beta.ico',
    deleteAppDataOnUninstall: false,
    differentialPackage: true,
    artifactName: 'StreamFusion-Beta-Setup-${version}.${ext}'
  },
  portable: {
    artifactName: 'StreamFusion-Beta-Portable-${version}.${ext}'
  },
  // Publish channel = 'beta' means electron-builder generates beta.yml
  // instead of latest.yml. The beta build's auto-updater (see main.js
  // — reads app.getName() and sets autoUpdater.channel = 'beta' when
  // running as the beta variant) looks specifically at beta.yml, so
  // beta installs never accidentally downgrade to or duplicate the
  // main channel's releases.
  publish: [
    {
      provider: 'github',
      owner:    'aquiloplays',
      repo:     'StreamFusion',
      channel:  'beta',
      releaseType: 'prerelease'
    }
  ]
};

builder.build({
  targets: builder.Platform.WINDOWS.createTarget(['nsis', 'portable']),
  config: config,
  publish: 'never'
}).then(function() {
  console.log('[build-beta] done. artifacts in dist-beta/');
}).catch(function(err) {
  console.error('[build-beta] failed:', err);
  process.exit(1);
});
