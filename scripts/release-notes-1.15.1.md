# StreamFusion 1.15.1: sign-in and feed-noise fixes

A small patch on the heels of 1.15.0.

## 🔧 Fixed

- **Twitch sign-in**: the auth broker was rejecting every token exchange
  (server-side credential mismatch, now surfaced properly and corrected).
  If sign-in failed for you on 1.15.0, just try **Connect Twitch** again.
- **"General: Custom" cards in the events feed**: Streamer.bot's internal
  action-to-action messages no longer appear in the feed at all. Everything
  intentional (raid finder, stream info, PayPal tips, aquilo.gg product
  events) keeps its own explicit pipeline and still shows normally.

If the app doesn't offer the update immediately, it checks on every launch
and every 4 hours.
