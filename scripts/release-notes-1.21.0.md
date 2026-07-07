# StreamFusion 1.21.0: the bot moves to the cloud

One bot, one place. StreamFusion's built-in chat bot and go-live Schedule now run as the **Aquilo Bot** — in the cloud, 24/7, across Twitch, Kick and YouTube — so nothing depends on the app being open, and there's no more guessing which product answers your commands.

## ☁️ Bot → Aquilo Bot

- **Everything moved, nothing lost.** Custom commands, counters, automated messages, auto-moderation (+ !permit), quotes and giveaways now live at [aquilo.gg/bot](https://aquilo.gg/bot/) — same features, plus a loyalty economy, minigames, a hype train and multi-platform chat.
- **One-click migration.** Settings → Bot has a **Copy my bot config** button; paste the result into the bot dashboard's "Migrate from StreamFusion" card and your commands, counter tallies, timers, filters and quotes import in one shot. Your local data is never deleted.
- **Schedule went cloud too.** The go-live auto title/category/tags (+ announce) now fires off Twitch's own go-live signal, even if your PC is mid-reboot. Configure it on the bot dashboard.

## 🔢 Counters, everywhere

- **New product: [aquilo.gg/counters](https://aquilo.gg/counters/).** Every counter is a chat command (`!deaths +`), a big button in the [Aquilo Dock](https://aquilo.gg/dock/panel/) OBS panel, a **Stream Deck key** (any deck that can open a URL — SOOMFON, Elgato, all of them), and a styleable OBS overlay that updates live.

## 🛠️ Fixes

- **Kick viewer count** polling could die at startup with a script error — fixed.
