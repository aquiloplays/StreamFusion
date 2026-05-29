# aquilo-favorites worker

Cloud sync for the StreamFusion **Stream Info → Favorites** feature. Stores each
user's stream-info presets in Cloudflare KV so favorites travel between machines.

## Data model

KV keys:

- `fav:<patreonUserId>:<twitchId>` → `{ "favorites": [...], "updatedAt": <ms> }`
- `tok:<sha256(accessToken)>` → `<patreonUserId>` (10-min cache)

Scoping is by **Patreon identity** (the stable cross-machine id SF already
manages) × **linked Twitch channel id**. The Patreon token is verified
server-side against `https://www.patreon.com/api/oauth2/v2/identity`, so the
client can't write to another user's namespace.

## Endpoints

| Method | Path                          | Body                          | Returns                          |
|--------|-------------------------------|-------------------------------|----------------------------------|
| GET    | `/health`                     | —                             | `aquilo-favorites ok`            |
| GET    | `/favorites?twitchId=<id>`    | —                             | `{ ok, favorites, updatedAt }`   |
| PUT    | `/favorites?twitchId=<id>`    | `{ favorites, updatedAt }`    | `{ ok, updatedAt }`              |

All `/favorites` calls require `Authorization: Bearer <patreon_access_token>`.
SF's **main process** attaches the token (the renderer never sees it).

## Deploy

```sh
cd favorites-worker
npm install
# 1) create the KV namespace, paste the printed id into wrangler.toml:
npx wrangler kv namespace create FAVORITES
# 2) (first time) add the favorites.aquilo.gg custom domain to the zone, or
#    comment out the [[routes]] block to deploy on *.workers.dev for testing.
npx wrangler deploy
```

The client base URL defaults to `https://favorites.aquilo.gg` and can be
overridden with the `SF_FAVORITES_URL` env var (see main.js).

## Notes

- Last-write-wins via `updatedAt`. Adequate for the small, single-user payload;
  there's no field-level merge.
- A user entitled to Early Access **via Discord only** (no Patreon token) gets
  local-only favorites — the panel still works, it just won't sync until they
  link Patreon. SF surfaces this in the Favorites sync line.
