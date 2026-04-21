#!/usr/bin/env node
// Post a GitHub release's notes to the configured Discord channel via
// the StreamFusion bot service's /post-release endpoint.
//
// Usage:
//   node scripts/post-release-notes.js <tag>
// Example:
//   node scripts/post-release-notes.js v1.5.0
//
// Works for BOTH the stable repo (aquiloplays/StreamFusion) and the
// private beta repo (aquiloplays/StreamFusion-beta) — the target repo
// is auto-detected from the GITHUB_REPOSITORY env var that GitHub
// Actions sets on every run, with fallbacks for local invocation.
//
// Required env vars:
//   SF_BOT_SERVICE_URL         Base URL of the bot service (default:
//                              https://streamfusion-production-0bdd.up.railway.app)
//   SF_RELEASE_POST_SECRET     Shared secret matching RELEASE_POST_SECRET on
//                              Railway. Set the SAME value on BOTH repos.
//   SF_RELEASE_CHANNEL_ID      Target Discord channel id (default:
//                              1494765819891159202 — community #releases)
//
// Optional env vars (per-repo via Actions secrets):
//   SF_RELEASE_REPO            owner/repo to pull the release from. Defaults
//                              to GITHUB_REPOSITORY (auto-set by Actions) or
//                              aquiloplays/StreamFusion for local runs. Beta
//                              Actions resolves to aquiloplays/StreamFusion-beta.
//   SF_RELEASE_PING_ROLE_ID    Discord role ID to @ping in the message content
//                              when the post goes out. Stable repo secret:
//                              1486090420675936488 (StreamFusion Updates).
//                              Beta repo secret: 1483242263961407670 (Tier 3
//                              Patron). Empty / unset → no role ping.
//   SF_RELEASE_EMBED_COLOR     Embed sidebar color. Accepts decimal (16034827)
//                              or hex (0xF59E0B / #F59E0B). Defaults to SF
//                              blue on the bot side. Beta repo should set
//                              0xF59E0B so patrons can visually tell beta
//                              release posts apart from stable.
//   SF_GITHUB_PAT              GitHub token for the release fetch. Public
//                              stable releases use GITHUB_TOKEN automatically
//                              at ~60 req/hr; for the PRIVATE beta repo the
//                              Actions runner's built-in GITHUB_TOKEN works
//                              because it's scoped to the repo the workflow
//                              runs in. No extra PAT needed.
//
// The script fetches the release from GitHub, extracts its notes, sends
// them to the bot service which posts them to Discord as the bot. The
// call is idempotent on Discord's side (each invocation creates a new
// message) — if you re-run, you'll post the notes twice. That's on you.

'use strict';

const https = require('https');

const BOT_BASE = (process.env.SF_BOT_SERVICE_URL || 'https://streamfusion-production-0bdd.up.railway.app').replace(/\/$/, '');
const SECRET   = process.env.SF_RELEASE_POST_SECRET || '';
const CHANNEL  = process.env.SF_RELEASE_CHANNEL_ID  || '1494765819891159202';
const GH_PAT   = process.env.SF_GITHUB_PAT          || '';
const REPO     = process.env.SF_RELEASE_REPO || process.env.GITHUB_REPOSITORY || 'aquiloplays/StreamFusion';
const PING     = (process.env.SF_RELEASE_PING_ROLE_ID || '').trim();
const COLOR_RAW = (process.env.SF_RELEASE_EMBED_COLOR || '').trim();

// Parse embed color — accepts "16034827", "0xF59E0B", "#F59E0B", or "F59E0B".
// Bot service defaults to SF blue (0x3A86FF) if we omit it entirely.
let COLOR = null;
if (COLOR_RAW) {
  const hexMatch = COLOR_RAW.match(/^(?:0x|#)?([0-9a-f]{6})$/i);
  if (hexMatch) {
    COLOR = parseInt(hexMatch[1], 16);
  } else if (/^\d+$/.test(COLOR_RAW)) {
    COLOR = parseInt(COLOR_RAW, 10);
  }
  if (COLOR == null || !Number.isFinite(COLOR) || COLOR < 0 || COLOR > 0xFFFFFF) {
    console.warn('warn: SF_RELEASE_EMBED_COLOR="' + COLOR_RAW + '" is not a valid color — falling back to bot default');
    COLOR = null;
  }
}

// Sanitize the tag input before we trust it: trim whitespace and strip
// any character that isn't [A-Za-z0-9._-]. A stray close-paren or quote
// from a copy-paste breaks the GitHub API lookup with a confusing 404.
// Forcing a leading 'v' lets the caller pass either "v1.5.0" or "1.5.0".
const rawTag = (process.argv[2] || '').trim();
const tag = rawTag.replace(/[^\w.-]/g, '').replace(/^v?/, 'v');
if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error('usage: node scripts/post-release-notes.js <tag>\n       e.g. node scripts/post-release-notes.js v1.5.0');
  console.error('got:   ' + JSON.stringify(rawTag) + (rawTag !== tag ? ' (sanitized to ' + JSON.stringify(tag) + ')' : ''));
  process.exit(2);
}
if (rawTag !== tag) {
  console.log('note: input "' + rawTag + '" sanitized to "' + tag + '"');
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
  console.log('repo:    ' + REPO);
  console.log('tag:     ' + tag);
  console.log('channel: ' + CHANNEL);
  if (PING)  console.log('pingRoleId: ' + PING);
  if (COLOR != null) console.log('color:   0x' + COLOR.toString(16).toUpperCase().padStart(6, '0'));

  // 1) Pull release from GitHub. For private repos (the beta one), the
  // Actions-provided GITHUB_TOKEN has read access to the repo it runs
  // in, so passing it via SF_GITHUB_PAT is required there. For public
  // stable, it's optional (helps with rate limiting).
  const ghHeaders = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'StreamFusion-ReleasePoster/1.0',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (GH_PAT) ghHeaders['Authorization'] = 'Bearer ' + GH_PAT;

  process.stdout.write('fetching release ' + tag + ' from ' + REPO + '… ');
  const rel = await httpJson('GET',
    'https://api.github.com/repos/' + REPO + '/releases/tags/' + tag,
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
    url:       rel.body.html_url || ('https://github.com/' + REPO + '/releases/tag/' + tag)
  };
  if (PING)          payload.pingRoleId = PING;
  if (COLOR != null) payload.color      = COLOR;

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
