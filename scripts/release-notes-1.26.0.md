# StreamFusion 1.26.0: read every message

Two upgrades to the chat you actually read on stream: foreign-language messages get translated inline, and replies and highlighted messages now reach your OBS chat overlay when you run StreamFusion as your chat source.

## 🌍 Inline chat translation

- **Foreign-language chat, translated in place.** Turn it on and any non-English message shows a `↳ translation` line right under the original, so you can read your whole chat without leaving the app.
- **You choose how aggressive.** A second toggle also translates plain-text messages (Spanish, French, and the like); leave it off to translate only what clearly needs it and keep the API calls down.
- **Fast and quiet.** Translations are cached, messages already in your language are skipped, and a failed or slow lookup simply shows nothing rather than blocking the message.
- **Find it under** Settings, in the chat options.

## 💬 Reply context + highlights on the overlay

- **Reply threads show on your overlay.** When a viewer replies to another message, the OBS chat overlay now renders the reply line, matching what you see in the app.
- **"Highlight My Message" carries through.** Twitch highlight redemptions get the purple treatment on the overlay too.
- **App-source parity.** This closes the gap where these only worked on the overlay's direct Streamer.bot path; StreamFusion-as-chat-source now forwards both.
