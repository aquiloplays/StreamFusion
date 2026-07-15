// platform-chat.js — native YouTube + Kick chat readers (main process).
//
// Mirrors the Twitch-native EventSub path: once the streamer signs in with
// Kick / YouTube (browser-auth.js), we read their live chat WITHOUT
// Streamer.bot and forward each message to the renderer, which turns it into
// the same Kick.ChatMessage / YouTube.ChatMessage events handleSBEvent already
// understands. The renderer gates on S.sbConnected so SB still wins when it's
// connected (identical to _esRoute's `if (S.sbConnected) return`).
//
//   Kick    — public Pusher WebSocket (chatrooms.<id>.v2). No OAuth needed to
//             READ; the chatroom id is resolved from the channel slug via
//             kick.com's API (Chromium net.request to clear Cloudflare, same
//             trick as the viewer-count fetch).
//   YouTube — the live video is discovered from the broadcaster's OAuth
//             (liveBroadcasts.list, youtube.readonly) with a keyless
//             channel/live scrape fallback, then chat is pulled KEYLESS via the
//             innertube get_live_chat endpoint (zero Data-API quota, so it can
//             never die mid-stream the way liveChatMessages.list polling would).
//
// All network + tokens stay in the main process; the renderer only ever sees
// normalized chat objects on the 'platform-chat' channel and status on
// 'platform-chat-status'.

const https = require('https');
// Guarded so the module can be required (and its parsers unit-tested) outside
// Electron; in the app these always resolve.
let net = null;
try { ({ net } = require('electron')); } catch (e) { net = null; }
let WS = null;
try { WS = require('ws'); } catch (e) { WS = null; } // readers no-op if ws is missing

// Kick's public Pusher app (stable, shared by kick.com itself + every reader).
const KICK_PUSHER_URL =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Injected by main.js so this module needs no import cycle.
let getWin = () => null;        // () => BrowserWindow | null
let getToken = () => null;      // (platform) => access_token | null
function init(opts) {
  opts = opts || {};
  if (typeof opts.getWin === 'function') getWin = opts.getWin;
  if (typeof opts.getToken === 'function') getToken = opts.getToken;
}

function send(channel, payload) {
  try {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  } catch (e) { /* window gone — non-fatal */ }
}
function emitMsg(obj) { send('platform-chat', obj); }
function emitStatus(platform, status) { send('platform-chat-status', Object.assign({ platform }, status)); }

// ── HTTP helpers ─────────────────────────────────────────────────────────────
// Kick sits behind Cloudflare; Electron's net (Chromium stack, real TLS
// fingerprint) clears the challenge where plain-Node https gets a 403.
function kickGet(path) {
  return new Promise((resolve) => {
    if (!net) { resolve(null); return; }
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = net.request({ method: 'GET', url: 'https://kick.com' + path, redirect: 'follow' });
      req.setHeader('Accept', 'application/json');
      req.setHeader('User-Agent', UA);
      const timer = setTimeout(() => { try { req.abort(); } catch (e) {} done(null); }, 10000);
      req.on('response', (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode < 200 || res.statusCode >= 300) { done(null); return; }
          try { done(JSON.parse(data)); } catch (e) { done(null); }
        });
        res.on('error', () => { clearTimeout(timer); done(null); });
      });
      req.on('error', () => { clearTimeout(timer); done(null); });
      req.end();
    } catch (e) { done(null); }
  });
}

function httpsRequest(options, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => { done({ status: res.statusCode || 0, body: data }); });
        res.on('error', () => { done(null); });
      });
      req.on('error', () => done(null));
      req.setTimeout(15000, () => { try { req.destroy(); } catch (e) {} done(null); });
      if (body) req.write(body);
      req.end();
    } catch (e) { done(null); }
  });
}
async function httpsGetText(url, headers) {
  const u = new URL(url);
  const r = await httpsRequest({
    method: 'GET', hostname: u.hostname, path: u.pathname + u.search,
    headers: Object.assign({ 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Cookie': 'CONSENT=YES+1' }, headers || {}),
  });
  return r && r.status >= 200 && r.status < 400 ? r.body : null;
}
async function httpsJson(options, body) {
  const r = await httpsRequest(options, body);
  if (!r || r.status < 200 || r.status >= 300) return null;
  try { return JSON.parse(r.body); } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Kick reader
// ═══════════════════════════════════════════════════════════════════════════
const kick = { ws: null, chatroomId: null, slug: null, stopped: true, backoff: 1000, keepalive: null };

async function kickResolveChatroom(slug) {
  const enc = encodeURIComponent(slug);
  let j = await kickGet('/api/v2/channels/' + enc);
  if (j && j.chatroom && j.chatroom.id) return String(j.chatroom.id);
  j = await kickGet('/api/v1/channels/' + enc);
  if (j && j.chatroom && j.chatroom.id) return String(j.chatroom.id);
  return null;
}

async function kickStart(slug) {
  slug = String(slug || '').trim().toLowerCase().replace(/^@+/, '');
  kick.stopped = false;
  kick.slug = slug;
  if (!slug) { emitStatus('kick', { state: 'error', message: 'No Kick channel — sign in or set your Kick slug.' }); return; }
  emitStatus('kick', { state: 'connecting' });
  if (!kick.chatroomId) {
    const id = await kickResolveChatroom(slug);
    if (kick.stopped) return;
    if (!id) { emitStatus('kick', { state: 'error', message: 'Could not reach that Kick channel.' }); kickRetry(); return; }
    kick.chatroomId = id;
  }
  kickConnect();
}

function kickConnect() {
  if (kick.stopped || !WS || !kick.chatroomId) { if (!WS) emitStatus('kick', { state: 'error', message: 'WebSocket support unavailable.' }); return; }
  let ws;
  try { ws = new WS(KICK_PUSHER_URL); } catch (e) { kickRetry(); return; }
  kick.ws = ws;
  ws.on('message', (raw) => {
    let f;
    try { f = JSON.parse(raw.toString()); } catch (e) { return; }
    if (f.event === 'pusher:connection_established') {
      try { ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: 'chatrooms.' + kick.chatroomId + '.v2' } })); } catch (e) {}
      kick.backoff = 1000;
      emitStatus('kick', { state: 'live' });
      return;
    }
    if (f.event === 'pusher:ping') { try { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); } catch (e) {} return; }
    if (f.event === 'App\\Events\\ChatMessageEvent') {
      let d;
      try { d = JSON.parse(f.data); } catch (e) { return; }
      const s = d.sender || {};
      const idn = s.identity || {};
      emitMsg({
        platform: 'kick',
        // content keeps Kick's inline [emote:ID:name] tokens — renderKickMessage
        // turns those into <img> emotes, so nothing else is needed for emotes.
        content: typeof d.content === 'string' ? d.content : '',
        messageId: d.id || '',
        user: {
          username: s.username || s.slug || '?',
          displayName: s.username || '',
          profileImageUrl: s.profile_pic || '',
          color: (idn && idn.color) || '',
        },
      });
    }
  });
  ws.on('close', () => { if (kick.ws === ws) kick.ws = null; if (!kick.stopped) kickRetry(); });
  ws.on('error', () => { try { ws.close(); } catch (e) {} });
  // Client keepalive: Pusher drops idle sockets after ~120s.
  clearInterval(kick.keepalive);
  kick.keepalive = setInterval(() => {
    try { if (kick.ws && kick.ws.readyState === 1) kick.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch (e) {}
  }, 60000);
}

function kickRetry() {
  if (kick.stopped) return;
  emitStatus('kick', { state: 'connecting' });
  const wait = Math.min(kick.backoff, 30000);
  kick.backoff = Math.min(kick.backoff * 2, 30000);
  setTimeout(() => { if (!kick.stopped) kickConnect(); }, wait);
}

function kickStop() {
  kick.stopped = true;
  clearInterval(kick.keepalive); kick.keepalive = null;
  try { if (kick.ws) { kick.ws.removeAllListeners(); kick.ws.close(); } } catch (e) {}
  kick.ws = null; kick.chatroomId = null;
  emitStatus('kick', { state: 'off' });
}

// ═══════════════════════════════════════════════════════════════════════════
// YouTube reader
// ═══════════════════════════════════════════════════════════════════════════
const yt = {
  stopped: true, channelId: null, videoId: null, apiKey: null,
  clientVersion: '2.20240401.00.00', continuation: null, timer: null,
  discoverTimer: null, backoff: 3000, seen: null,
};

// Discovery A — the broadcaster's active broadcast via OAuth (clean + reliable).
async function ytDiscoverViaOAuth() {
  const token = getToken('youtube');
  if (!token) return null;
  const j = await httpsJson({
    method: 'GET', hostname: 'www.googleapis.com',
    path: '/youtube/v3/liveBroadcasts?part=id&broadcastStatus=active&broadcastType=all&maxResults=1',
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  if (j && Array.isArray(j.items) && j.items[0] && j.items[0].id) return String(j.items[0].id);
  return null;
}

// Discovery B — keyless scrape of the channel's /live page (no token, so an
// expired OAuth token can't stop reading once the channel id is known).
async function ytDiscoverViaScrape() {
  if (!yt.channelId) return null;
  const html = await httpsGetText('https://www.youtube.com/channel/' + encodeURIComponent(yt.channelId) + '/live');
  if (!html) return null;
  // Only trust a videoId when the page also says it's live right now.
  if (!/"isLiveNow":true|"isLive":true|"style":"LIVE"/.test(html)) return null;
  const m = html.match(/"videoId":"([\w-]{11})"/);
  return m ? m[1] : null;
}

async function ytDiscover() {
  return (await ytDiscoverViaOAuth()) || (await ytDiscoverViaScrape());
}

// Bootstrap innertube: pull the api key, client version + first continuation
// token from the live_chat page for the resolved video.
async function ytInitChat(videoId) {
  const html = await httpsGetText('https://www.youtube.com/live_chat?is_popout=1&v=' + encodeURIComponent(videoId));
  if (!html) return false;
  const key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
  const cver = (html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) ||
    html.match(/"clientVersion":"([\d.]+)"/) || [])[1];
  const cont =
    (html.match(/"(?:invalidationContinuationData|timedContinuationData|reloadContinuationData)":\{(?:[^{}]|\{[^{}]*\})*?"continuation":"([^"]+)"/) ||
     html.match(/"continuation":"([^"]+)"/) || [])[1];
  if (!key || !cont) return false;
  yt.apiKey = key;
  if (cver) yt.clientVersion = cver;
  yt.continuation = cont;
  return true;
}

function ytRuns(messageObj) {
  const runs = (messageObj && messageObj.runs) || [];
  const parts = [];
  let text = '';
  for (const run of runs) {
    if (run.text) { parts.push({ text: run.text }); text += run.text; }
    else if (run.emoji) {
      const e = run.emoji;
      const th = (e.image && e.image.thumbnails) || [];
      const url = th.length ? th[th.length - 1].url : '';
      const label = (e.shortcuts && e.shortcuts[0]) || (e.image && e.image.accessibility &&
        e.image.accessibility.accessibilityData && e.image.accessibility.accessibilityData.label) || '';
      if (url) parts.push({ imageUrl: url, text: label });
      else if (label) { parts.push({ text: label }); }
      text += label ? label : '';
    }
  }
  return { parts, text };
}
function ytBadges(authorBadges) {
  const out = { owner: false, mod: false, member: false };
  for (const b of (authorBadges || [])) {
    const r = b && b.liveChatAuthorBadgeRenderer;
    if (!r) continue;
    const icon = r.icon && r.icon.iconType;
    if (icon === 'OWNER') out.owner = true;
    else if (icon === 'MODERATOR') out.mod = true;
    else if (r.customThumbnail) out.member = true; // member badges are custom images
  }
  return out;
}
function ytThumb(photo) {
  const th = (photo && photo.thumbnails) || [];
  return th.length ? th[th.length - 1].url : '';
}

async function ytPollOnce() {
  const body = JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion: yt.clientVersion, hl: 'en' } },
    continuation: yt.continuation,
  });
  const j = await httpsJson({
    method: 'POST', hostname: 'www.youtube.com',
    path: '/youtubei/v1/live_chat/get_live_chat?key=' + encodeURIComponent(yt.apiKey) + '&prettyPrint=false',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  if (!j) return { ok: false };
  const lcc = j.continuationContents && j.continuationContents.liveChatContinuation;
  if (!lcc) return { ok: false, ended: true };

  const c0 = (lcc.continuations || [])[0] || {};
  const cd = c0.invalidationContinuationData || c0.timedContinuationData || c0.reloadContinuationData;
  const next = cd && cd.continuation ? cd.continuation : null;
  let timeout = cd && cd.timeoutMs ? cd.timeoutMs : 2500;
  if (timeout < 1500) timeout = 1500;

  for (const a of (lcc.actions || [])) {
    const item = a && a.addChatItemAction && a.addChatItemAction.item;
    if (!item) continue;
    const r = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
    if (!r) continue;
    if (yt.seen && r.id) { if (yt.seen.has(r.id)) continue; yt.seen.add(r.id); if (yt.seen.size > 600) yt.seen = new Set(); }
    const { parts, text } = ytRuns(r.message);
    if (!text && !(parts && parts.length)) continue;
    const badges = ytBadges(r.authorBadges);
    emitMsg({
      platform: 'youtube',
      broadcast: { id: yt.videoId },
      messageId: r.id || '',
      message: text,
      parts: parts && parts.length ? parts : null,
      user: {
        name: (r.authorName && r.authorName.simpleText) || '?',
        profileImageUrl: ytThumb(r.authorPhoto),
        isOwner: badges.owner, isModerator: badges.mod, isMember: badges.member,
      },
    });
  }
  return { ok: true, next, timeout };
}

function ytScheduleDiscover(delay) {
  clearTimeout(yt.discoverTimer);
  yt.discoverTimer = setTimeout(ytTryDiscover, delay);
}
async function ytTryDiscover() {
  if (yt.stopped) return;
  emitStatus('youtube', { state: 'connecting' });
  const videoId = await ytDiscover();
  if (yt.stopped) return;
  if (!videoId) { ytScheduleDiscover(30000); return; } // not live yet — check again
  yt.videoId = videoId;
  yt.seen = new Set();
  const ok = await ytInitChat(videoId);
  if (yt.stopped) return;
  if (!ok) { ytScheduleDiscover(15000); return; }
  emitStatus('youtube', { state: 'live' });
  ytLoop();
}
async function ytLoop() {
  if (yt.stopped) return;
  const res = await ytPollOnce();
  if (yt.stopped) return;
  if (res.ended || (!res.ok && !res.next && !yt.continuation)) {
    // Stream/chat ended or the continuation went stale — re-discover.
    yt.videoId = null; yt.continuation = null; yt.apiKey = null;
    emitStatus('youtube', { state: 'connecting' });
    ytScheduleDiscover(20000);
    return;
  }
  if (!res.ok) { yt.timer = setTimeout(ytLoop, Math.min(yt.backoff, 15000)); yt.backoff = Math.min(yt.backoff * 2, 15000); return; }
  yt.backoff = 3000;
  if (res.next) yt.continuation = res.next;
  yt.timer = setTimeout(ytLoop, res.timeout || 2500);
}

function ytStart(channelId) {
  yt.stopped = false;
  yt.channelId = channelId ? String(channelId) : yt.channelId;
  yt.videoId = null; yt.continuation = null; yt.apiKey = null; yt.seen = new Set();
  ytScheduleDiscover(0);
}
function ytStop() {
  yt.stopped = true;
  clearTimeout(yt.timer); yt.timer = null;
  clearTimeout(yt.discoverTimer); yt.discoverTimer = null;
  yt.videoId = null; yt.continuation = null; yt.apiKey = null; yt.seen = null;
  emitStatus('youtube', { state: 'off' });
}

// ── public control surface ────────────────────────────────────────────────────
function start(platform, opts) {
  opts = opts || {};
  if (platform === 'kick') { kick.chatroomId = null; kickStart(opts.slug || ''); }
  else if (platform === 'youtube') ytStart(opts.channelId || '');
}
function stop(platform) {
  if (platform === 'kick') kickStop();
  else if (platform === 'youtube') ytStop();
}
function stopAll() { kickStop(); ytStop(); }

module.exports = {
  init, start, stop, stopAll,
  // exported for unit tests / fixtures
  _internal: { ytRuns, ytBadges, ytThumb, kickResolveChatroom },
};
