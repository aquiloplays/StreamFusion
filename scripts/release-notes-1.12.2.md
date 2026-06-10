# StreamFusion 1.12.2

Two streamer-requested chat-dock improvements.

## What's new for you

### 📑 Chat / Events view tabs

A new three-tab filter row sits just above the feed:

- **All** , chat and events together (default, same as before)
- **Chat** , only chat messages; sub/cheer/raid/follow cards hidden
- **Events** , only events; chat messages hidden, the event tag chip
  gets a soft gold pill for emphasis

Each tab shows a live count. When activity arrives on a tab you're
not viewing, the badge flips gold to flag the unread item, then
clears the moment you click that tab. Selection persists across dock
reloads.

Useful when:
- A sub-bomb buries chat , click **Chat** to read regular chat while
  events keep counting in the background.
- You're reviewing the recap , click **Events** to scroll just the
  paid moments.
- You want both , **All** is still the default.

### 🚫 Blocklist matches usernames, never words

The chat dock's blocklist now strictly matches the entire username,
case-insensitive, and never matches words in message bodies. Two
parser fixes:

- **Comma- or newline-separated**, not whitespace. So display names
  with spaces in them ("Mr Beast Gaming") stay intact as one entry
  instead of breaking into separate names.
- **Leading `@` is stripped**, so pasting "@trollkid" from chat works
  the same as typing "trollkid".

The Settings panel field is now a multi-line textarea with a clearer
placeholder and hint that spells out "usernames only (never matches
words in messages)". Behavior was already username-only under the
hood; this release just makes that contract impossible to misread.

## Under the hood

- `setView(v)` writes `cfg.view`, sets a body class
  (`view-all`/`view-chat`/`view-events`), and CSS rules hide the
  irrelevant message rows. No DOM mutation of feed contents , the
  tab switch is a pure visibility flip, so scroll position stays
  sane and reverting tabs is instant.
- `bumpView(kind)` increments the per-tab counter and flags the
  unread state on tabs the streamer isn't viewing. The "unread"
  badge clears on tab click.
- `isBlocked(name)` split regex changed from `/[,\s]+/` to `/[,\n]+/`;
  entries get a `.replace(/^@+/, "")` to strip the pasted `@`
  prefix; the lookup itself is unchanged (exact case-insensitive
  username match against `m.user`).

## Migrating from 1.12.1

Nothing to do. View tab defaults to All (the existing behavior).
Existing blocklist entries keep working , the parser is more
permissive, not stricter.
