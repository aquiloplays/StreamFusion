const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, limited API to the renderer (index.html)
contextBridge.exposeInMainWorld('electronAPI', {
  minimize:   () => ipcRenderer.send('minimize-window'),
  maximize:   () => ipcRenderer.send('maximize-window'),
  closeToTray:() => ipcRenderer.send('close-window'),
  quit:       () => ipcRenderer.send('quit-app'),
  getVersion: () => ipcRenderer.invoke('app-version'),
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
  // 1.7.x: optional global hotkey that fires the pop-out's Send-to-chat
  // button. Same plumbing as the overlay toggle — registered via
  // globalShortcut in the main process so it works even when the pop-out
  // window (not the main app) has focus on stream.
  popoutSetSendHotkey: (accel) => ipcRenderer.invoke('popout-set-send-hotkey', accel),
  popoutGetSendHotkey: ()      => ipcRenderer.invoke('popout-get-send-hotkey'),
  // Overlay listens for chat-send fire-from-hotkey events.
  onOverlayFireChatSend: (fn)  => ipcRenderer.on('overlay-fire-chat-send', fn),
  // Visibility toggle hotkey (hide/show the pop-out; position preserved)
  overlaySetVisHotkey:(accel) => ipcRenderer.invoke('overlay-set-vis-hotkey', accel),
  overlayGetVisHotkey:()      => ipcRenderer.invoke('overlay-get-vis-hotkey'),
  // 1.5.1: configure Mouse4/Mouse5 → hotbar slot bindings. slot is the
  // 0-indexed hotbar slot to fire, or null to unbind.
  setMouseHotbarBinding:  (button, slot) => ipcRenderer.invoke('mouse-set-hotbar-binding', { button: button, slot: slot }),
  getMouseHotbarBindings: ()             => ipcRenderer.invoke('mouse-get-hotbar-bindings'),
  // Sync ALL hotbar slot → keyboard-accelerator bindings to the main
  // process. The renderer is the source of truth (lives in
  // hotbarActions[i].hotkey, persisted with sf_settings); this IPC
  // pushes the full slot→accel map and the main process re-registers
  // atomically. Pass an object like { '0': 'F13', '1': 'Ctrl+Shift+2',
  // '2': 'Mouse4' } — empty / missing entries clear that slot.
  // Returns { ok, registered: [], failed: [], conflicted: [] } so the
  // settings UI can warn the streamer when an accel is already taken
  // by another app or by the overlay-toggle / overlay-vis hotkeys.
  hotbarSyncHotkeys:      (map) => ipcRenderer.invoke('hotbar-sync-hotkeys', map || {}),
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
  // Direct-Twitch "Stream" control-action hotkeys. Renderer owns persistence
  // and pushes the full { accel -> actionId } map; main registers globally
  // (keyboard accelerators incl. F13-F24) + Mouse4/Mouse5 via the poller, then
  // sends 'stream-action-fire' with the actionId when a binding fires.
  streamHotkeysSync:(map)     => ipcRenderer.invoke('stream-hotkeys-sync', map || {}),
  onStreamActionFire:(fn)     => ipcRenderer.on('stream-action-fire', (e, id) => fn(id)),
  // After the overlay re-registers its hotkeys (globalShortcut.unregisterAll),
  // main asks the renderer to re-push hotbar / stream-info / stream-action
  // bindings so they survive the wipe.
  onRehydrateHotkeys:(fn)     => ipcRenderer.on('rehydrate-hotkeys', () => fn()),
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
  // Renderer tells main: a pending update has been downloaded. Main uses
  // this so the close-dialog can change its default action to "Install
  // Update & Restart" instead of the usual Minimize-to-Tray default,
  // which silently swallowed updates when users clicked X expecting an
  // install.
  notifyUpdateDownloaded: (ver)  => ipcRenderer.send('update-downloaded-notify', ver || ''),
  // Surfaced when quitAndInstall throws so the renderer can re-enable the
  // toolbar Update Now button + show an error in Settings → About.
  onUpdateInstallFailed: (fn)    => ipcRenderer.on('update-install-failed', (e, d) => fn(d)),
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

  // (Patreon entitlement bridges removed 2026-06-30 — Patreon is retired.)

  // ── Discord entitlement (parallel EA path, see discord-auth.js) ─────────
  // (Discord entitlement bridges removed with the rest of the supporter
  // gating: every feature is available to everyone, no sign-in required.
  // The renderer's old connect/apply callers are all `if (electronAPI.x)`
  // guarded, so they no-op without these.)

  // ── Twitch account (direct Helix: Clip + future; chat/mod/stream-info stay on Streamer.bot) ──
  twitchBeginAuth:       ()   => ipcRenderer.invoke('twitch-begin-auth'),
  twitchGetStatus:       ()   => ipcRenderer.invoke('twitch-get-status'),
  twitchSignOut:         ()   => ipcRenderer.invoke('twitch-sign-out'),
  twitchCreateClip:      ()   => ipcRenderer.invoke('twitch-create-clip'),
  twitchHelix:           (p)  => ipcRenderer.invoke('twitch-helix', p || {}),
  onTwitchStatusChanged: (fn) => ipcRenderer.on('twitch-status-changed', (e, status) => fn(status)),
  // Optional bot account (second Twitch login) for automated messages / bot.
  twitchBotBeginAuth:       ()   => ipcRenderer.invoke('twitch-bot-begin-auth'),
  twitchBotGetStatus:       ()   => ipcRenderer.invoke('twitch-bot-get-status'),
  twitchBotSignOut:         ()   => ipcRenderer.invoke('twitch-bot-sign-out'),
  twitchBotSendChat:        (p)  => ipcRenderer.invoke('twitch-bot-send-chat', p || {}),
  onTwitchBotStatusChanged: (fn) => ipcRenderer.on('twitch-bot-status-changed', (e, status) => fn(status)),

  // ── OBS overlays (EA-only — broadcasts are no-ops until entitled) ───────
  // Renderer-side fan-out: anything the main app learns (chat msg, event,
  // shoutout click) goes to the OBS overlay server, which forwards to
  // every connected browser source via SSE. All three functions take a
  // payload object; data contracts live in the hosted overlay sources
  // at aquilo-site/public/sf/overlay/*/index.html (the bundled
  // obs-overlays/ copies were migrated to aquilo.gg on 2026-06-09).
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
  // Push a directive to a connected Aquilo product's control SSE stream.
  // command is one of 'play' | 'pause' | 'skip' | 'previous'. args is an
  // optional product-specific object. Returns { ok, reason? } — the
  // renderer disables the button + shows a hint when no widget is connected.
  obsControlIntegration:(clientId, command, args) => ipcRenderer.invoke('obs-integration-control', { clientId: clientId, command: command, args: args || {} }),
  // Snapshot of connected Aquilo products. Used by the now-playing card
  // to find a 'aquilo-spotify-widget' entry and read its meta + clientId.
  obsIntegrationList:   ()             => ipcRenderer.invoke('obs-integration-list'),
  // OBS browser-source auto-refresh — connects to the OBS WebSocket
  // plugin, lists browser sources, and refreshes those whose URL
  // points at SF's loopback overlay ports. Used to recover OBS
  // sources stuck on a "this site can't be reached" error page after
  // SF auto-update / restart.
  obsRefreshSources:    ()             => ipcRenderer.invoke('obs-refresh-sources'),
  obsRefreshCfgGet:     ()             => ipcRenderer.invoke('obs-refresh-cfg-get'),
  obsRefreshCfgSet:     (patch)        => ipcRenderer.invoke('obs-refresh-cfg-set', patch || {}),

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
  // (Shared-bot bridges removed 2026-06-30 — feature retired in 1.7.x.)

  // ── Stream Info favorites (cloud sync) ──────────────────────────────────
  // Cross-machine sync for Stream Info presets. The main process attaches the
  // user's Patreon access token (renderer never sees it) and falls back to a
  // local userData cache when offline / not Patreon-linked. Returns:
  //   { ok, favorites:[], updatedAt, cloudSynced?|offline?|localOnly?, syncError? }
  // Early-access feature manifest (features.json). Returns the parsed object or
  // null. The renderer's isFeatureEnabled() gates EA features off this.
  getFeatures:  ()                               => ipcRenderer.invoke('get-features'),

  favoritesGet: (twitchId)                       => ipcRenderer.invoke('favorites-get', twitchId),
  favoritesPut: (twitchId, favorites, updatedAt) => ipcRenderer.invoke('favorites-put', { twitchId: twitchId, favorites: favorites, updatedAt: updatedAt }),
  // Bot-config cloud sync (same worker + Twitch-token auth as favorites).
  botConfigGet: (twitchId)                    => ipcRenderer.invoke('bot-config-get', twitchId),
  botConfigPut: (twitchId, config, updatedAt) => ipcRenderer.invoke('bot-config-put', { twitchId: twitchId, config: config, updatedAt: updatedAt }),

  // Stream Info quick-swap global hotkeys. Map: { open, fav1..fav5 }. Returns
  // { ok, registered, failed, conflicted }. Main fires open-stream-info /
  // si-apply-pinned-fav back to the renderer.
  streamInfoSyncHotkeys: (map) => ipcRenderer.invoke('stream-info-sync-hotkeys', map || {}),
  onOpenStreamInfo:      (fn)  => ipcRenderer.on('open-stream-info', fn),
  onApplyPinnedFav:      (fn)  => ipcRenderer.on('si-apply-pinned-fav', (e, n) => fn(n)),

  // ── Rotation Relay (free for all users) ─────────────────────────────────
  // Subscribes to the streamer's Rotation widget over the cloud relay so
  // song events show up in the events tab + chat overlay. Streamer pastes
  // their room key (visible in Rotation's config.html under "Connect to
  // StreamFusion") here; the main process owns the WebSocket.
  //
  // Events arrive via onRotationEvent({ kind, data, ts }):
  //   - rotation.song.playing   — now playing changed
  //   - rotation.song.queued    — viewer's !sr just landed in queue
  //   - rotation.song.requested — chat command received
  //   - rotation.song.rejected  — request denied (cooldown / banned / etc.)
  //   - rotation.song.skipped   — track skipped
  rotationRelayGetStatus: ()          => ipcRenderer.invoke('rotation-relay-get-status'),
  rotationRelaySetConfig: (patch)     => ipcRenderer.invoke('rotation-relay-set-config', patch || {}),
  rotationRelayStop:      ()          => ipcRenderer.invoke('rotation-relay-stop'),
  onRotationEvent:        (fn)        => ipcRenderer.on('rotation-event',           (e, payload) => fn(payload)),
  onRotationRelayStatus:  (fn)        => ipcRenderer.on('rotation-relay-status',    (e, status)  => fn(status)),
  onRotationRelayBroadcast: (fn)      => ipcRenderer.on('rotation-relay-broadcast', (e, row)     => fn(row)),
});
