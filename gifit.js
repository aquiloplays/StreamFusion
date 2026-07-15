// ── Gif It ───────────────────────────────────────────────────────────────
// Auto-clip on a channel-point redeem. The renderer detects the matching
// redeem (via EventSub) and calls gifItCapture(); this module:
//   1) saves the OBS replay buffer + gets its file path (warden-agent),
//   2) renders a GIF and/or MP4 of the last N seconds with bundled ffmpeg,
//   3) uploads them to the streamer's Discord webhook (multipart),
//   4) archives the clips under <Videos>\GifIt.
// Everything is best-effort and returns a { ok, reason? } result the renderer
// turns into a toast. No state is kept here — the renderer passes config in.

const https = require('https');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app } = require('electron');
const warden = require('./warden-agent');

let logFn = function (m) { try { console.log('[gifit] ' + m); } catch (e) {} };

// Resolve the bundled ffmpeg. In a packaged build the path points inside
// app.asar, but the binary is unpacked (see package.json asarUnpack), so
// redirect to app.asar.unpacked. If the dep isn't installed yet, capture()
// reports 'no-ffmpeg' rather than throwing at require time.
let ffmpegPath = '';
try {
  ffmpegPath = require('ffmpeg-static') || '';
  if (ffmpegPath && ffmpegPath.indexOf('app.asar') !== -1) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
} catch (e) { ffmpegPath = ''; }

function init(opts) { if (opts && opts.log) logFn = opts.log; }

function _run(exe, argv, cb) {
  try {
    const p = spawn(exe, argv, { windowsHide: true });
    let err = '';
    p.stderr.on('data', function (d) { err += d.toString(); });
    p.on('error', function (e) { cb(false, String(e && e.message)); });
    p.on('close', function (code) { cb(code === 0, err); });
  } catch (e) { cb(false, String(e && e.message)); }
}

// Multipart upload of one or more local files to a Discord webhook. Mirrors
// printer.js's receipt mirror, generalized to N files.
function _uploadDiscord(webhook, files, content, cb) {
  try {
    const boundary = '----gifit' + Date.now().toString(36);
    const parts = [];
    parts.push(Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="payload_json"\r\n' +
      'Content-Type: application/json\r\n\r\n' + JSON.stringify({ content: content }) + '\r\n'));
    files.forEach(function (f, i) {
      parts.push(Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="files[' + i + ']"; filename="' + f.name + '"\r\n' +
        'Content-Type: ' + f.type + '\r\n\r\n'));
      parts.push(fs.readFileSync(f.path));
      parts.push(Buffer.from('\r\n'));
    });
    parts.push(Buffer.from('--' + boundary + '--\r\n'));
    const body = Buffer.concat(parts);
    const req = https.request(webhook, {
      method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length },
    }, function (res) {
      if (res.statusCode >= 400) { logFn('discord HTTP ' + res.statusCode); cb(false, 'http-' + res.statusCode); }
      else cb(true);
      res.resume();
    });
    req.on('error', function (e) { cb(false, String(e && e.message)); });
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} cb(false, 'timeout'); });
    req.end(body);
  } catch (e) { cb(false, String(e && e.message)); }
}

// opts: { user, rewardName, webhook, formats, seconds, fps, width, obsPort, obsPass }
function capture(opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    if (!ffmpegPath) { resolve({ ok: false, reason: 'no-ffmpeg' }); return; }
    if (!opts.webhook || opts.webhook.indexOf('https://discord.com/api/webhooks/') !== 0) {
      resolve({ ok: false, reason: 'no-webhook' }); return;
    }

    warden.captureReplay({ port: parseInt(opts.obsPort) || 4455, password: opts.obsPass || '' }, function (res) {
      if (!res || !res.ok) { resolve({ ok: false, reason: (res && res.reason) || 'obs-failed' }); return; }
      const src = res.path;

      // Give OBS a beat to finish flushing the file to disk.
      setTimeout(function () {
        const secs = Math.max(1, parseInt(opts.seconds) || 6);
        const fps = Math.max(5, parseInt(opts.fps) || 15);
        const width = Math.max(120, parseInt(opts.width) || 480);
        const formats = String(opts.formats || 'both').toLowerCase();
        const wantGif = formats === 'both' || formats === 'gif';
        const wantMp4 = formats === 'both' || formats === 'mp4';

        let dir;
        try { dir = path.join(app.getPath('videos'), 'GifIt'); fs.mkdirSync(dir, { recursive: true }); }
        catch (e) { dir = path.dirname(src); }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const gif = path.join(dir, 'clip-' + stamp + '.gif');
        const mp4 = path.join(dir, 'clip-' + stamp + '.mp4');

        const tasks = [];
        if (wantGif) tasks.push(function (next) {
          const vf = 'fps=' + fps + ',scale=' + width +
                     ':-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse';
          _run(ffmpegPath, ['-y', '-sseof', '-' + secs, '-i', src, '-vf', vf, gif], function () { next(); });
        });
        if (wantMp4) tasks.push(function (next) {
          _run(ffmpegPath, ['-y', '-sseof', '-' + secs, '-i', src,
            '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            '-c:a', 'aac', '-b:a', '128k', mp4], function () { next(); });
        });

        let i = 0;
        (function nextTask() {
          if (i >= tasks.length) { afterEncode(); return; }
          tasks[i++](nextTask);
        })();

        function afterEncode() {
          const files = [];
          if (wantGif && fs.existsSync(gif)) files.push({ path: gif, name: 'clip-' + stamp + '.gif', type: 'image/gif' });
          if (wantMp4 && fs.existsSync(mp4)) files.push({ path: mp4, name: 'clip-' + stamp + '.mp4', type: 'video/mp4' });
          if (!files.length) { resolve({ ok: false, reason: 'ffmpeg-failed' }); return; }
          const who = opts.user || 'someone';
          _uploadDiscord(opts.webhook, files, '🎞️ New clip from the stream — redeemed by ' + who + '!', function (ok, err) {
            resolve(ok ? { ok: true, files: files.map(function (f) { return f.path; }) }
                       : { ok: false, reason: err || 'upload-failed', files: files.map(function (f) { return f.path; }) });
          });
        }
      }, 800);
    });
  });
}

module.exports = { init, capture, hasFfmpeg: function () { return !!ffmpegPath; } };
