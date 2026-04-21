#!/usr/bin/env node
// Build a "StreamFusion Beta" variant. Installs alongside the main
// StreamFusion (different appId = different Windows identity), so you
// can run both and test pre-release changes without touching your
// day-to-day install. Its auto-updater is pinned to the 'beta' channel
// and targets the PRIVATE aquiloplays/StreamFusion-beta repo — only
// invited Tier 3 Patreon supporters get access to releases.
//
// Usage: npm run build:beta
//
// Output: dist-beta/StreamFusion-Beta-Setup-<ver>.exe + portable + beta.yml
//
// Version stamping: if package.json's version is already a semver
// prerelease (e.g. 1.5.1-beta.2), it's used as-is. Otherwise we
// append `-beta.0` so the next beta-only release-tag can take over.
//
// How this differs from the stable build:
//   - stable uses package.json's "build" field (merged into the
//     electron-builder config). Beta uses a dedicated
//     electron-builder-beta.json invoked via `--config`, which
//     REPLACES package.json's build field rather than merging.
//     Reason: electron-builder 24 has a deep-merge bug that corrupts
//     `publish[0]` when both the programmatic config and package.json
//     define it, producing a malformed `{ '0': {...}, provider, ... }`
//     object that fails schema validation with no useful error. Using
//     `--config` sidesteps the merge entirely and lets us point at a
//     different publish repo (StreamFusion-beta instead of
//     StreamFusion) cleanly.
//
// Release flow:
//   1. `npm run build:beta`
//   2. Upload assets to a GitHub release tagged e.g. v1.6.0-beta.1 on
//      aquiloplays/StreamFusion-beta (PRIVATE repo) and mark it as a
//      pre-release in the GitHub UI.
//   3. Upload `beta.yml` (produced alongside the installer) as an
//      asset too — that's the manifest the beta auto-updater reads.

'use strict';

const path = require('path');
const fs   = require('fs');
const { spawnSync } = require('child_process');
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

// Invoke electron-builder CLI. `--config` points at our dedicated
// config file (replaces package.json's build field). `--extraMetadata`
// overrides package.json fields at build time — we use it to stamp
// `version` and `name` on the bundled app's package.json without
// touching the repo's package.json. The `-c.` prefix tells
// electron-builder this is a config-path override.
const configPath = path.join(REPO_ROOT, 'electron-builder-beta.json');
const betaName   = 'streamfusion-beta';

// Windows: .cmd shim; POSIX: bash shim. spawnSync on Windows can't
// launch `.cmd` directly (CreateProcess ENOENT) unless shell:true,
// so we always go via the shell. Quoting the path handles spaces.
const binName = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder';
const binPath = path.join(REPO_ROOT, 'node_modules', '.bin', binName);

console.log('[build-beta] invoking electron-builder CLI with --config ' + path.basename(configPath));
const args = [
  '--win',
  '--config', JSON.stringify(configPath),
  '--publish', 'never',
  '-c.extraMetadata.version=' + version,
  '-c.extraMetadata.name=' + betaName
];
const result = spawnSync(JSON.stringify(binPath) + ' ' + args.join(' '), {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  shell: true,
  env: Object.assign({}, process.env, {
    // Prevent electron-builder from trying to auto-discover a code
    // signing identity (fails on this machine without a cert).
    CSC_IDENTITY_AUTO_DISCOVERY: 'false'
  })
});

if (result.status !== 0) {
  console.error('[build-beta] electron-builder exited with code', result.status);
  process.exit(result.status || 1);
}

// Rename latest.yml → beta.yml. electron-builder writes the manifest
// as `latest.yml` by default because the publish config doesn't
// specify a channel. The beta variant's auto-updater is pinned to
// channel = 'beta' (see main.js) so it fetches `beta.yml` from the
// GitHub release — without this rename, beta installs would never
// see update manifests.
const outDir = path.join(REPO_ROOT, 'dist-beta');
const src = path.join(outDir, 'latest.yml');
const dst = path.join(outDir, 'beta.yml');
try {
  if (fs.existsSync(src)) {
    fs.renameSync(src, dst);
    console.log('[build-beta] renamed latest.yml → beta.yml');
  } else {
    console.warn('[build-beta] WARN: latest.yml not found in dist-beta/ — auto-updater manifest missing');
  }
} catch (e) {
  console.error('[build-beta] manifest rename failed:', e.message);
  process.exit(1);
}

console.log('[build-beta] done. artifacts in dist-beta/');
