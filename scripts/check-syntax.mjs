#!/usr/bin/env node
// Syntax gate for `npm run check` and .github/workflows/ci.yml.
//
// This repo has no bundler, linter, or test suite — the app is plain JS
// loaded directly by Electron (CommonJS) and Cloudflare Workers (ESM), so
// the cheapest meaningful gate is `node --check` over every first-party JS
// file. Requires Node >= 22: module-syntax auto-detection is what lets
// `--check` parse the ESM workers despite their .js extension.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Local-only helper that .gitignore excludes; skip it so a dev checkout
// that has it on disk sees the same result as CI.
const IGNORE = new Set(['preview-icon.js']);

const listJs = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js') && !IGNORE.has(e.name))
    .map((e) => join(dir, e.name));

const files = [
  ...listJs('.'),
  ...listJs('scripts'),
  'favorites-worker/worker.js',
  'release-worker/worker.js',
];

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', join(root, file)], {
    encoding: 'utf8',
  });
  if (res.status === 0) {
    console.log(`ok   ${file}`);
  } else {
    failed += 1;
    console.error(`FAIL ${file}\n${res.stderr.trim()}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed the syntax check`);
  process.exit(1);
}
console.log(`\nAll ${files.length} files passed node --check`);
