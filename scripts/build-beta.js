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

// Regenerate icon assets before the electron-builder run — same prebuild
// hook the main build uses. Done inline here so `npm run build:beta`
// doesn't need a separate prebuild target.
try {
  require('./gen-icon');
} catch (e) { console.warn('[build-beta] gen-icon prebuild failed:', e.message); }

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
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'StreamFusion Beta',
    installerHeaderIcon: 'assets/icon.ico',
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
