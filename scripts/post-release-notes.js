#!/usr/bin/env node
// Post a GitHub release's notes to the configured Discord channel via
// the StreamFusion bot service's /post-release endpoint.
//
// Usage:
//   node scripts/post-release-notes.js <tag>
// Example:
//   node scripts/post-release-notes.js v1.5.0
//
// Required env vars:
//   SF_BOT_SERVICE_URL      Base URL of the bot service (default:
//                           https://streamfusion-production-0bdd.up.railway.app)
//   SF_RELEASE_POST_SECRET  Shared secret matching RELEASE_POST_SECRET set on
//                           Railway. Set this locally in your shell before
//                           running: export SF_RELEASE_POST_SECRET="..."
//   SF_RELEASE_CHANNEL_ID   Target Discord channel id (default:
//                           1494765819891159202)
//
// Optional:
//   SF_GITHUB_PAT           A GitHub token to use for the release fetch if
//                           you're hitting the rate limit unauthenticated;
//                           most runs don't need this since GitHub's public
//                           release API allows ~60 req/hr per IP.
//
// The script fetches the release from GitHub, extracts its notes, sends
// them to the bot service which posts them to Discord as the bot. The
// call is idempotent on Discord's side (each invocation creates a new
// message) — if you re-run, you'll post the notes twice. That's on you.

'use strict';

const https = require('https');

const BOT_BASE = (process.env.SF_BOT_SERVICE_URL || 'https://streamfusion-production-0bdd.up.railway.app').replace(/\/$/, '');
const SECRET   = process.env.SF_RELEASE_POST_SECRET || '';
const CHANNEL  = process.env.SF_RELEASE_CHANNEL_ID || '1494765819891159202';
const GH_PAT   = process.env.SF_GITHUB_PAT || '';

const tag = (process.argv[2] || '').replace(/^v?/, 'v');
if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error('usage: node scripts/post-release-notes.js <tag>\n       e.g. node scripts/post-release-notes.js v1.5.0');
  process.exit(2);
}
if (!SECRET) {
  console.error('SF_RELEASE_POST_SECRET not set. Export it and re-run.');
  process.exit(2);
}

function httpJson(method, urlStr, opts) {
  opts = opts || {};
  return new Promise(function(resolve, reject) {
    const u = new URL(urlStr);
    const req = https.request({
      method: method,
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      port: u.port || 443,
      headers: opts.headers || {}
    }, function(res) {
      const chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, body: json, text: text });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, function() { req.destroy(new Error('timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

(async function main() {
  // 1) Pull release from GitHub.
  const ghHeaders = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'StreamFusion-ReleasePoster/1.0',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (GH_PAT) ghHeaders['Authorization'] = 'Bearer ' + GH_PAT;

  process.stdout.write('fetching release ' + tag + ' from GitHub… ');
  const rel = await httpJson('GET',
    'https://api.github.com/repos/aquiloplays/StreamFusion/releases/tags/' + tag,
    { headers: ghHeaders });
  if (rel.status !== 200 || !rel.body) {
    console.error('\nGitHub returned', rel.status);
    console.error(rel.text.slice(0, 300));
    process.exit(1);
  }
  console.log('ok');

  const version = (rel.body.tag_name || tag).replace(/^v/, '');
  const payload = {
    secret:    SECRET,
    channelId: CHANNEL,
    version:   version,
    title:     rel.body.name || ('StreamFusion ' + version),
    body:      rel.body.body || '(no notes)',
    url:       rel.body.html_url || ('https://github.com/aquiloplays/StreamFusion/releases/tag/' + tag)
  };

  process.stdout.write('posting to ' + BOT_BASE + '/post-release → channel ' + CHANNEL + '… ');
  const post = await httpJson('POST', BOT_BASE + '/post-release', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (post.status === 200 && post.body && post.body.ok) {
    console.log('ok, message id', post.body.messageId);
    process.exit(0);
  } else {
    console.error('FAILED');
    console.error('status:', post.status);
    console.error('body:', post.text);
    process.exit(1);
  }
})();
