# StreamFusion — Setup Guide

Made by **aquilo_plays**

StreamFusion is a desktop chat aggregator for Twitch, YouTube, and TikTok LIVE. It connects to **Streamer.bot** (for Twitch & YouTube) and **Tikfinity** (for TikTok) and brings all your chats into one clean window.

---

## Prerequisites

Before opening StreamFusion, make sure you have the following installed and running:

| Tool | Used for | Download |
|---|---|---|
| **Streamer.bot** | Twitch & YouTube chat, events, sending messages | streamer.bot |
| **Tikfinity** | TikTok LIVE chat & events | tikfinity.com |

You only need the tools for the platforms you stream on. Tikfinity is not required if you don't use TikTok.

---

## Step 1 — Install StreamFusion

Run `StreamFusion Setup 1.0.0.exe` and follow the installer. After it finishes, launch the app from your Desktop or Start Menu.

The first time you open it you'll see a welcome screen. Click **Let's go** to proceed. Check **Don't show again** if you want to skip it next time.

---

## Step 2 — Set Up Streamer.bot (Twitch & YouTube)

StreamFusion talks to Streamer.bot over its built-in WebSocket server.

### 2a. Enable the WebSocket server in Streamer.bot

1. Open **Streamer.bot**
2. Go to **Servers/Clients** → **WebSocket Server**
3. Make sure **Auto Start** is checked and click **Start Server**
4. Note the **Host** (usually `127.0.0.1`) and **Port** (usually `8080`)
5. If you set a **Password**, note it down — you'll need it in StreamFusion

### 2b. Connect in StreamFusion

1. In the sidebar on the left, click **Connect** next to **Streamer.bot**
2. Enter the Host and Port from above (defaults are already filled in)
3. If your WebSocket server has a password set, enter it in the **Password** field
4. Click **Connect**

The dot next to Streamer.bot will turn green when connected. Twitch and YouTube viewer counts and events will start appearing automatically.

> **Note:** Viewer count shows as `–` until Streamer.bot sends its first update, which can take up to a few minutes. It then refreshes every 2 minutes.

---

## Step 3 — Set Up Tikfinity (TikTok)

Tikfinity bridges your TikTok LIVE stream to StreamFusion via a local WebSocket.

### 3a. Configure Tikfinity

1. Open **Tikfinity** and log in with your TikTok account
2. Go to **Settings** → note the **WebSocket port** (default is `21213`)
3. Make sure the WebSocket server is enabled

### 3b. Connect in StreamFusion

1. In the sidebar, click **Connect** next to **Tikfinity**
2. The port will be pre-filled to `21213` — change it if you set a different port
3. Click **Connect**

The dot next to Tikfinity will turn green when connected.

---

## The Interface

### Top Bar

| Button | What it does |
|---|---|
| **Settings** | Toggles the left sidebar open/closed |
| **Pause** | Pauses incoming messages (useful during fast chat) |
| **Clear** | Clears the chat feed |
| **Chat** | Opens the message input bar at the bottom |
| **Quick** | Opens/closes your quick-send message buttons |
| **Events** | Opens/closes the Events panel on the right |
| **Raid** | Opens the Raid Finder panel |

The viewer count badges (TW / YT / TT) appear in the top bar once data is received.

### Left Sidebar

- **Connections** — Connect/disconnect Streamer.bot and Tikfinity
- **Show Platforms** — Toggle Twitch, YouTube, or TikTok messages on/off in the feed
- **Event Filters** — Choose which event types show in the Events panel (follows, subs, gifts, etc.)
- **Chat Size** — Adjust the font size of the chat feed
- **Sound Alerts** — Enable sounds for specific events; adjust the volume
- **Keyword Highlight** — Words you add here get highlighted in gold whenever anyone types them
- **Block List** — Messages from blocked usernames are silently filtered out
- **Emotes** — Shows emote load status; Twitch emotes (7TV, BTTV, FFZ, channel) load automatically after connecting

### Events Panel

Click **Events** in the top bar to slide it open. All follows, subs, cheers, gifts, raids, and other events appear here in real time, newest at the top.

Important events (subs, gift subs, cheers, TikTok gifts over 1,000 coins) are displayed larger and bolder so they stand out at a glance.

---

## Sending Chat Messages

1. Click **Chat** in the top bar to show the input bar
2. Select which platform(s) to send to using the **TW / YT / TT** toggle buttons in the bar
3. Type your message and press **Enter** (or click the send arrow)

> Sending messages requires Streamer.bot to be connected for Twitch/YouTube, and Tikfinity for TikTok.

### Quick Messages

Click **Quick** to open the quick-send bar. Click any button to send that message instantly. Right-click a button to edit or delete it. Use the **+** button to add new ones.

---

## Moderation (Twitch)

Each Twitch chat message has a small shield icon on the right. Click it to open a mod menu with options to:

- **Timeout** a user (30 seconds, 10 minutes, or 1 hour)
- **Ban** a user
- **Delete** the specific message

> Mod actions require Streamer.bot to be connected and your Twitch account to have moderator or broadcaster permissions.

---

## Raid Finder (Early Access)

The Raid Finder helps you find streamers playing the same game with a similar viewer count to raid when you end your stream. It uses your existing Streamer.bot Twitch login — no extra tokens or API keys needed.

> **Early Access:** Raid Finder is available to Patreon Tier 2+ supporters. Connect your Patreon in **Settings → Early Access** to unlock it.

### How it works

1. Click **Raid** in the top bar
2. The first time, StreamFusion will prompt you to import two small actions into Streamer.bot — just copy the string, paste it into SB's Import dialog, and confirm
3. If your stream is live, StreamFusion automatically detects your game and viewer count
4. Adjust the viewer range if needed (defaults to 50%–150% of your current viewers)
5. Click **Find Targets** — StreamFusion searches Twitch for live streamers in the same game
6. Browse the results and click **Raid →** on the channel you want to raid

### Requirements

- Streamer.bot must be connected
- Twitch must be signed in inside Streamer.bot (same as the rest of StreamFusion)
- Your stream should be live so SF can detect your game and viewer count

### Customising the raid action

The imported "Start Raid" action simply executes a Twitch raid. If you want to add a chat announcement, sound, or delay before the raid, open the action in Streamer.bot and add extra sub-actions above or below the existing one.

---

## Tips

- **Close to tray:** Clicking X minimises StreamFusion to the system tray rather than closing it. Right-click the tray icon to fully quit.
- **Reconnection:** If Streamer.bot or Tikfinity disconnects, StreamFusion will automatically retry every 5 seconds.
- **Settings are saved:** Your connection details, filters, sounds, and keywords are all saved automatically and restored on next launch.
- **Viewer count:** Twitch and Kick viewer counts refresh automatically every minute via public APIs. Streamer.bot also pushes Twitch `PresentViewers` events whenever they arrive.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Streamer.bot won't connect | Make sure the WebSocket server is started in Streamer.bot under Servers/Clients → WebSocket Server |
| "Authentication required" when sending chat | Streamer.bot has a password set — enter it in the connection dialog |
| "Auth failed" | Double-check the password in Streamer.bot matches what you entered |
| No Twitch viewer count | Wait up to 5 minutes after connecting, or trigger a stream update (change title/game) to speed it up |
| Tikfinity won't connect | Confirm the port number matches the one shown in Tikfinity's settings |
| Events show "Someone" instead of a username | Update Streamer.bot to the latest version; older versions send event data in a different format |
| Emotes not loading | Connect Streamer.bot first — emotes are fetched using your Twitch channel ID from Streamer.bot |
