# StreamFusion 1.19.0: sign in with your browser

Logging into your platforms just got easier. StreamFusion now opens your **default browser** — where you're already signed in — instead of an in-app login, and brings that one-click flow to **Kick and YouTube** alongside Twitch.

## 🌐 Browser sign-in for Kick & YouTube
- **One click, no password.** Connect Kick or YouTube from Settings and your browser opens on aquilo.gg — approve, come back, and you're connected. No in-app login window to fight with.
- **You're probably already logged in.** Because it uses your real browser session, most streamers just click "Approve" and they're done.

## 🎵 TikTok attribution
- **Add your TikTok @username** so gifts, follows, and events get matched to you. TikTok has no login API, so a handle is all it takes.

## 🔒 Safer by design
- Sign-in is brokered through aquilo.gg, so **client secrets never live on your machine**.
- The token hand-off is bound to a private key the app holds — a sign-in link that leaks **can't be replayed** to steal your session.

Twitch sign-in is unchanged and still works exactly as before.
