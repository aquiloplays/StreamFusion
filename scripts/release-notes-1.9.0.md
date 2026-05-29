# StreamFusion 1.9.0 — Stream Info editor (EARLY ACCESS)

Edit your Twitch **title, category and tags** without leaving StreamFusion — and
save favorite presets that sync across your machines for instant game-swaps.

> **Early Access.** This feature is gated while we finish the wider early-access
> system. Link your Patreon (any tier — free linking counts) to unlock it. Already
> a patron connected through Discord? That unlocks it too.

## ✏️ Stream Info panel

A new **Stream Info** button on the toolbar opens an editor with:

- **Title** with a live 140-character counter.
- **Category** search with autocomplete and box-art thumbnails (plus your recent
  searches).
- **Tags** — add up to 10.
- **Status badge** that shows whether your draft matches what's live, and a
  **diff** of exactly what will change before you hit **Apply**.
- A **Twitch listing-card preview** so you can see how your stream will read, and
  a **LIVE** pulse when you're online.
- A subtle "saved" toast on success.

Everything runs through your existing **Streamer.bot** Twitch connection — no extra
login. The first time you open it, SF gives you a one-click Streamer.bot import for
three small actions (read / update / category search). Updating title & category
needs the `channel:manage:broadcast` scope on your SB Twitch login (granted by
default for broadcasters; SF tells you if you need to re-authorize).

## ⭐ Favorites

- **Save** the current title + category + tags as a named preset.
- **Apply** any favorite in one click to swap your live stream instantly.
- **Edit, delete, pin** (pinned float to the top), **drag to reorder**, and
  **search/filter**.
- Favorites are **cloud-synced** per Twitch channel, so they travel between your
  machines. (Offline or not-yet-Patreon-linked? They're saved locally and sync
  when you reconnect / link.)

## ⌨️ Quick-swap hotkeys

- A global shortcut to open the Stream Info panel.
- Global shortcuts to apply pinned favorites #1–5 instantly — zero-click
  game-swaps mid-stream. Configure them in the panel's **Hotkeys** tab.

---

_Existing features are unchanged. The Stream Info feature is opt-in and gated, so
it stays out of the way until you unlock and set it up._
