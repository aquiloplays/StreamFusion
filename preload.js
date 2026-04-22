const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, limited API to the renderer (index.html)
contextBridge.exposeInMainWorld('electronAPI', {
  minimize:   () => ipcRenderer.send('minimize-window'),
  maximize:   () => ipcRenderer.send('maximize-window'),
  closeToTray:() => ipcRenderer.send('close-window'),
  quit:       () => ipcRenderer.send('quit-app'),
  getVersion: () => ipcRenderer.invoke('app-version'),
  // True when this install is the StreamFusion Beta variant. Renderer
  // uses it to show the BETA wordmark + tier-3 upsell UI.
  isBeta:     () => ipcRenderer.invoke('is-beta'),
  fetchKickViewers: (slug)    => ipcRenderer.invoke('fetch-kick-viewers', slug),
  fetchTwitchViewers: (login) => ipcRenderer.invoke('fetch-twitch-viewers', login),
  fetchTwitchGame: (login)    => ipcRenderer.invoke('fetch-twitch-game', login),
  // Overlay (pop-out chat)
  openOverlay:      (opts)    => ipcRenderer.invoke('open-overlay', opts || {}),
  closeOverlay:     ()        => ipcRenderer.send('close-overlay'),
  sendOverlayData:  (data)    => ipcRenderer.send('overlay-data', data),
  onOverlayClosed:  (fn)      => ipcRenderer.on('overlay-closed', fn),
  onOverlayReady:   (fn)      => ipcRenderer.on('overlay-ready', fn),
  // Called from overlay window
  onOverlayData:    (fn)      => ipcRenderer.on('overlay-data', (e, d) => fn(d)),
  overlayReady:     ()        => ipcRenderer.send('overlay-ready'),
  overlaySetOpacity:(v)       => ipcRenderer.send('overlay-set-opacity', v),
  overlayClickThrough:(v)     => ipcRenderer.send('overlay-click-through', v),
  overlaySetHotkey: (accel)   => ipcRenderer.invoke('overlay-set-hotkey', accel),
  overlayGetHotkey: ()        => ipcRenderer.invoke('overlay-get-hotkey'),
  // Visibility toggle hotkey (hide/show the pop-out; position preserved)
  overlaySetVisHotkey:(accel) => ipcRenderer.invoke('overlay-set-vis-hotkey', accel),
  overlayGetVisHotkey:()      => ipcRenderer.invoke('overlay-get-vis-hotkey'),
  // 1.5.1: configure Mouse4/Mouse5 → hotbar slot bindings. slot is the
  // 0-indexed hotbar slot to fire, or null to unbind.
  setMouseHotbarBinding:  (button, slot) => ipcRenderer.invoke('mouse-set-hotbar-binding', { button: button, slot: slot }),
  getMouseHotbarBindings: ()             => ipcRenderer.invoke('mouse-get-hotbar-bindings'),
  overlayToggleVisibility:()  => ipcRenderer.send('overlay-toggle-visibility'),
  overlaySetBounds: (b)       => ipcRenderer.send('overlay-set-bounds', b || {}),
  onOverlayToggleInteract:(fn)=> ipcRenderer.on('overlay-toggle-interact', fn),
  // Main app -> overlay: force a lock state (true/false) or toggle (undefined)
  setOverlayLocked: (locked)  => ipcRenderer.send('overlay-set-locked', locked),
  // Overlay listens for external lock toggles issued by the main window
  onOverlayExternalLock:(fn)  => ipcRenderer.on('overlay-external-lock', fn),
  // Main app listens for overlay lock-state changes to keep its icon in sync
  onOverlayLockState:(fn)     => ipcRenderer.on('overlay-lock-state', (e, v) => fn(v)),
  // Overlay notifies main process that its lock state changed
  overlayLockChanged:(locked) => ipcRenderer.send('overlay-lock-changed', !!locked),
  // Hold-to-interact: main process polls global Ctrl state and forwards
  // up/down events to the overlay renderer
  onOverlayHoldKey:(fn)       => ipcRenderer.on('overlay-hold-key', (e, down) => fn(!!down)),
  // Overlay -> main renderer: send a chat message via the main app's
  // existing per-platform send pipeline (so the overlay needs no credentials)
  sendOverlayChat: (payload)  => ipcRenderer.send('overlay-send-chat', payload || {}),
  // Main renderer listens for chat-send requests forwarded from the overlay
  onOverlaySendChat:(fn)      => ipcRenderer.on('overlay-send-chat', (e, d) => fn(d)),
  // Overlay -> main renderer: fire a quick-action hotbar button by index.
  // Main app owns the SB websocket so the overlay just passes the index.
  overlayFireHotbar:(idx)     => ipcRenderer.send('overlay-fire-hotbar', idx),
  // Main renderer listens for hotbar-fire requests forwarded from the overlay
  onOverlayFireHotbar:(fn)    => ipcRenderer.on('overlay-fire-hotbar', (e, idx) => fn(idx)),
  // Overlay -> main renderer: trigger a mod action (timeout/ban/delete) via the
  // main app's SB websocket, so the overlay doesn't need platform credentials.
  sendOverlayModAction:(payload) => ipcRenderer.send('overlay-mod-action', payload || {}),
  onOverlayModAction:(fn)     => ipcRenderer.on('overlay-mod-action', (e, d) => fn(d)),
  // Main renderer -> main process: request a physical shake of the overlay
  // window (for big paid events — tips, gift bombs, high bit cheers, etc.)
  overlayShake:    (intensity)=> ipcRenderer.send('overlay-shake', intensity || 1),
  // External banner window: overlay sends banner/raid data to main process,
  // which creates a transparent window adjacent to the pop-out. Slides
  // left or right so it never clips the monitor edge.
  showExternalBanner:(data)   => ipcRenderer.send('show-external-banner', data),
  // Banner window listens for data pushed from main process
  onBannerData:    (fn)       => ipcRenderer.on('banner-data', (e, d) => fn(d)),
  // Banner window signals ready
  bannerReady:     ()         => ipcRenderer.send('banner-ready'),
  // Banner window signals animation done — main process hides the window
  bannerDone:      ()         => ipcRenderer.send('banner-done'),
  // Auto-updater
  onUpdateAvailable:  (fn)      => ipcRenderer.on('update-available', (e, d) => fn(d)),
  onUpdateDownloaded: (fn)      => ipcRenderer.on('update-downloaded', (e, d) => fn(d)),
  downloadUpdate:     ()        => ipcRenderer.send('download-update'),
  installUpdate:      ()        => ipcRenderer.send('install-update'),
  // Manual "Check for updates" trigger from Settings > About > Updates.
  // Returns { ok, status } — status is 'checking' | 'up-to-date' |
  // 'update-available' — so the renderer can reflect state in the UI.
  checkForUpdates:    ()        => ipcRenderer.invoke('check-for-updates'),
  // Settings export / import
  exportSettings:     ()        => ipcRenderer.invoke('export-settings'),
  importSettings:     ()        => ipcRenderer.invoke('import-settings'),
  writeExportFile:    (p, d)    => ipcRenderer.invoke('write-export-file', p, d),
  // Crash log
  openLogFolder:      ()        => ipcRenderer.send('open-log-folder'),
  // ── Promo overlay (hidden in settings; OBS Window Capture advertisement) ──
  // Separate from the regular pop-out overlay — a streamer can have both
  // open simultaneously (their functional pop-out + the on-stream promo).
  openPromo:          (opts)    => ipcRenderer.invoke('open-promo', opts || {}),
  closePromo:         ()        => ipcRenderer.send('close-promo'),
  sendPromoData:      (data)    => ipcRenderer.send('promo-data', data),
  // Main renderer listens for promo lifecycle events so it can flip its
  // open/closed indicator and push an initial stats snapshot on open.
  onPromoReady:       (fn)      => ipcRenderer.on('promo-ready', fn),
  onPromoClosed:      (fn)      => ipcRenderer.on('promo-closed', fn),
  // Promo renderer (promo.html) listens for pushed chat/event/stats/live data
  onPromoData:        (fn)      => ipcRenderer.on('promo-data', (e, d) => fn(d)),
  // Promo renderer signals it has finished loading and is ready to receive
  promoReady:         ()        => ipcRenderer.send('promo-ready'),

  // ── Patreon entitlement (optional sign-in; unlocks EA features) ─────────
  // Public entitlement shape (returned by the three functions below, and
  // also the payload of the `patreon-entitlement-changed` event):
  //   {
  //     signedIn:     bool,            // a Patreon token is cached
  //     entitled:     bool,            // signedIn AND active on Tier 2 or Tier 3
  //     tier:         'tier3' | 'tier2' | 'tier1' | 'follower' | 'none',
  //     patronStatus: 'active_patron' | 'declined_patron' | 'former_patron' | null,
  //     reason:       'entitled' | 'insufficient_tier' | 'declined_patron'
  //                   | 'former_patron' | 'follower' | 'not_a_member'
  //                   | 'no_memberships' | 'offline_grace' | 'reverify_failed'
  //                   | 'not_signed_in' | 'unknown',
  //     userName:     string,          // Patreon full_name, blank when signed out
  //     verifiedAt:   number | null    // epoch ms of last successful check
  //   }
  //
  // Renderer usage:
  //   const st = await window.electronAPI.patreonGetEntitlement();
  //   if (st.entitled) { /* show EA features */ }
  //   window.electronAPI.onPatreonEntitlementChanged(function(st) { /* react */ });
  //
  // Starts the OAuth flow. Opens Patreon in the system browser, catches the
  // loopback callback, exchanges tokens via the Cloudflare proxy, and
  // verifies Tier 2 / Tier 3 membership. Returns the entitlement state.
  patreonBeginAuth:              ()  => ipcRenderer.invoke('patreon-begin-auth'),
  // Returns the current entitlement state. Uses cache when fresh; reverifies
  // against Patreon when the cache is older than 24h. Safe to call anytime.
  patreonGetEntitlement:         ()  => ipcRenderer.invoke('patreon-get-entitlement'),
  // Forgets the cached Patreon token. The app keeps working; EA features go
  // away until the user signs in again.
  patreonSignOut:                ()  => ipcRenderer.invoke('patreon-sign-out'),
  // Subscribe to live entitlement changes (sign-in, sign-out, hourly
  // re-verification, membership revocation). Handler receives the public
  // entitlement shape documented above.
  onPatreonEntitlementChanged:   (fn) => ipcRenderer.on('patreon-entitlement-changed', (e, state) => fn(state)),

  // ── Discord entitlement (parallel EA path, see discord-auth.js) ─────────
  // Second route to EA features: if the user connects their Discord and
  // has Tier 2 or Tier 3 Patron role in aquilo.gg, they're entitled.
  // Useful when Patreon OAuth misses (Apple private-relay emails, new-
  // pledge sync lag). Either path alone is enough — renderer ORs them.
  //
  // Public entitlement shape returned by discordGetEntitlement() + payload
  // of `discord-entitlement-changed` event:
  //   {
  //     signedIn:     bool,            // a Discord token is cached
  //     entitled:     bool,            // signedIn AND Tier 2/3 role in guild
  //     tier:         'tier3' | 'tier2' | 'none',
  //     reason:       'entitled' | 'no_role' | 'not_in_guild'
  //                   | 'reverify_failed' | 'offline_grace' | 'not_signed_in',
  //     userName:     string,          // Discord global_name or username
  //     userId:       string,          // Discord snowflake
  //     verifiedAt:   number | null
  //   }
  discordBeginAuth:              ()  => ipcRenderer.invoke('discord-begin-auth'),
  discordGetEntitlement:         ()  => ipcRenderer.invoke('discord-get-entitlement'),
  discordSignOut:                ()  => ipcRenderer.invoke('discord-sign-out'),
  onDiscordEntitlementChanged:   (fn) => ipcRenderer.on('discord-entitlement-changed', (e, state) => fn(state)),

  // ── OBS overlays (EA-only — broadcasts are no-ops until entitled) ───────
  // Renderer-side fan-out: anything the main app learns (chat msg, event,
  // shoutout click) goes to the OBS overlay server, which forwards to
  // every connected browser source via SSE. All three functions take a
  // payload object; see obs-overlays/*.html for the data contracts.
  obsBroadcastChat:     (data)        => ipcRenderer.send('obs-broadcast-chat',     data || {}),
  obsBroadcastAlert:    (data)        => ipcRenderer.send('obs-broadcast-alert',    data || {}),
  obsBroadcastShoutout: (data)        => ipcRenderer.send('obs-broadcast-shoutout', data || {}),
  // Update per-overlay config (chat/alerts/shoutout). Server remembers
  // the last config and replays it to new clients so OBS sources pick up
  // the streamer's settings even after an OBS restart.
  //   obsSetConfig('chat', { fontSize: 20, bgOpacity: 0.4, ... })
  obsSetConfig:         (overlay, cfg) => ipcRenderer.send('obs-set-config',        { overlay: overlay, cfg: cfg || {} }),
  // Get server status + URLs for the Settings panel. Returns:
  //   { running: bool, clients: number, urls: { root, chat, alerts, shoutout } }
  obsGetStatus:         ()            => ipcRenderer.invoke('obs-get-status'),

  // ── Discord integration (EA-only) ────────────────────────────────────────
  // Webhook POST — fires a stylized embed to a Discord webhook URL. The
  // caller passes a full Discord webhook payload (usually { embeds: [...] }).
  // Returns { ok, status, id } — id is the Discord message id, which the
  // records feature remembers so it can delete-and-repost.
  discordWebhookPost:   (url, body)   => ipcRenderer.invoke('discord-webhook-post',   { url: url, body: body }),
  // Webhook DELETE by message id. Used to wipe the previous records
  // message before posting the new one.
  discordWebhookDelete: (url, msgId)  => ipcRenderer.invoke('discord-webhook-delete', { url: url, messageId: msgId }),
  // Bot Gateway lifecycle. Call discordBotConnect with a bot token and
  // optional guild/channel IDs to start observing Discord events; call
  // discordBotDisconnect to stop. discord-event IPC fires with the shape
  //   { kind: 'member_add'|'voice_join'|'message'|'ready'|...,
  //     data: { username, userId, guildId, channelId, content? } }
  discordBotConnect:    (cfg)         => ipcRenderer.invoke('discord-bot-connect',    cfg || {}),
  discordBotDisconnect: ()            => ipcRenderer.invoke('discord-bot-disconnect'),
  discordBotStatus:     ()            => ipcRenderer.invoke('discord-bot-status'),
  onDiscordEvent:       (fn)          => ipcRenderer.on('discord-event', (e, payload) => fn(payload)),
  // Shared StreamFusion bot — SSE connection to the hosted bot service
  // (aquilo.gg-run). The main process attaches the user's Patreon
  // access token from its own store; the renderer never sees it.
  sharedBotConnect:     (cfg)         => ipcRenderer.invoke('shared-bot-connect',    cfg || {}),
  sharedBotDisconnect:  ()            => ipcRenderer.invoke('shared-bot-disconnect'),
});
