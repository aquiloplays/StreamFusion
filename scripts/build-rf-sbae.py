"""Rebuild the StreamFusion Raid Finder SBAE with the v4 inline-C# action.

v1 (1.2.5): missing references. Compile-failed silently in SB → 15s timeout.
v2 (1.5.3): added System.Core / System.Net.Http / Newtonsoft.Json refs and
            bumped UUIDs so re-import didn't conflict.
v3 (1.5.4): same references; C# now accepts a `gameName` arg and resolves
            it to a real Twitch game id via /helix/games?name= when SF
            couldn't surface one from SB. Echoes resolved id+name back.
v4 (1.5.4): same references + game-name resolution; pagination rewrite to
            actually find streamers in the streamer's range. v3 capped at
            3 pages × 100 = top 300 streamers by viewer_count desc, which
            for popular games (LoL / Just Chatting) sits entirely above
            small-streamer ranges → zero matches. v4: page up to 25 pages
            (~2500 streamers), break early when sorted-past-range, and
            oversample to wantCount * 4 so the final mid-of-range sort
            has real options. Also echoes diagnostic counters
            (scanned/pages/inRange/hitCap) so SF can surface accurate
            "no results" messaging.
v5 (1.5.5-beta.6): UUIDs are now read from index.html (stable across
            rebuilds), so a re-import overwrites the existing actions in
            place rather than creating duplicates beside the old broken
            v1/v2 copies. CPH.LogInfo diagnostics added at every step
            of the find action so SB's Logs tab shows exactly where it
            stops when streamers report "Find Targets does nothing".
            No behaviour change to the happy path — just observability.

Cross-checked references against an existing working action in the user's
actions.json ("Discord Stream Logger | Stream Events").
"""
import base64, gzip, json, io, re, sys, pathlib

# v5 of Find Targets — game-name → game-id resolution server-side, plus
# CPH.LogInfo diagnostics at every step so the SB Logs tab tells the
# streamer (and us) exactly where it stops on failure.
FIND_CSHARP = r"""using System;
using System.Net.Http;
using System.Linq;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

public class CPHInline
{
    public bool Execute()
    {
        string gameId    = args.ContainsKey("gameId")    ? args["gameId"].ToString()    : "";
        string gameName  = args.ContainsKey("gameName")  ? args["gameName"].ToString()  : "";
        string reqId     = args.ContainsKey("sfReqId")   ? args["sfReqId"].ToString()   : "unknown";
        int    minViewers = args.ContainsKey("minViewers") ? Convert.ToInt32(args["minViewers"].ToString()) : 0;
        int    maxViewers = args.ContainsKey("maxViewers") ? Convert.ToInt32(args["maxViewers"].ToString()) : 2147483647;
        int    wantCount  = args.ContainsKey("wantCount")  ? Convert.ToInt32(args["wantCount"].ToString())  : 25;

        CPH.LogInfo("[SF rf v5] start reqId=" + reqId + " gameId='" + gameId + "' gameName='" + gameName + "' range=[" + minViewers + "," + maxViewers + "] want=" + wantCount);

        string clientId = CPH.TwitchClientId;
        string token    = CPH.TwitchOAuthToken;
        CPH.LogInfo("[SF rf v5] twitch creds: clientId=" + (string.IsNullOrEmpty(clientId) ? "EMPTY" : "len=" + clientId.Length) + " token=" + (string.IsNullOrEmpty(token) ? "EMPTY" : "len=" + token.Length));
        if (string.IsNullOrEmpty(clientId) || string.IsNullOrEmpty(token))
        {
            CPH.LogWarn("[SF rf v5] twitch_not_connected — sign in to Twitch inside Streamer.bot first");
            BroadcastErr(reqId, "twitch_not_connected");
            return true;
        }

        using (var http = new HttpClient())
        {
            http.DefaultRequestHeaders.Add("Client-ID", clientId);
            http.DefaultRequestHeaders.Add("Authorization", "Bearer " + token);

            // v3: if SF couldn't determine a game ID but knows the name
            // (decapi fallback / manual override / partial GetBroadcaster
            // shape), resolve it here via /helix/games?name=. Twitch's
            // canonical lookup — works even when SB hasn't surfaced the
            // category to its event bus yet.
            if (string.IsNullOrEmpty(gameId) && !string.IsNullOrEmpty(gameName))
            {
                CPH.LogInfo("[SF rf v5] resolving gameName='" + gameName + "' via /helix/games?name=");
                string gurl = "https://api.twitch.tv/helix/games?name=" + Uri.EscapeDataString(gameName);
                var gresp = http.GetAsync(gurl).GetAwaiter().GetResult();
                CPH.LogInfo("[SF rf v5] /helix/games status=" + (int)gresp.StatusCode);
                if (gresp.IsSuccessStatusCode)
                {
                    var gbody = JObject.Parse(gresp.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                    var garr = gbody["data"] as JArray;
                    if (garr != null && garr.Count > 0)
                    {
                        if (garr[0]["id"] != null)   gameId   = garr[0]["id"].Value<string>();
                        if (garr[0]["name"] != null) gameName = garr[0]["name"].Value<string>();
                        CPH.LogInfo("[SF rf v5] resolved gameId='" + gameId + "' gameName='" + gameName + "'");
                    }
                    else
                    {
                        CPH.LogWarn("[SF rf v5] /helix/games returned 0 rows for '" + gameName + "' — game name doesn't match a Twitch category exactly");
                    }
                }
                else
                {
                    string gerr = "";
                    try { gerr = gresp.Content.ReadAsStringAsync().GetAwaiter().GetResult(); } catch {}
                    CPH.LogWarn("[SF rf v5] /helix/games failed status=" + (int)gresp.StatusCode + " body=" + (gerr.Length > 200 ? gerr.Substring(0, 200) : gerr));
                }
            }

            if (string.IsNullOrEmpty(gameId))
            {
                CPH.LogWarn("[SF rf v5] missing_gameId — neither SF nor /helix/games resolved a Twitch category");
                BroadcastErr(reqId, "missing_gameId");
                return true;
            }

            // v4 pagination: /helix/streams returns results sorted by
            // viewer_count DESC, so for popular games (LoL / Just Chatting)
            // the top-300 cap from v3 always sat above small-streamer
            // viewer ranges and returned zero matches. Two changes:
            //   1) Cap at 25 pages (~2500 streamers) instead of 3.
            //   2) Break early when we hit a stream with viewer_count <
            //      minViewers — since results are sorted desc, no later
            //      stream can possibly be in range.
            //   3) Oversample to wantCount * 4 so the final mid-of-range
            //      sort has actual options to choose from (v3 took the
            //      first wantCount from the TOP of the range, missing
            //      smaller streamers entirely).
            var keep = new List<JObject>();
            string cursor = null;
            int pages = 0;
            int scanned = 0;
            int oversample = Math.Max(wantCount * 4, 50);
            const int MAX_PAGES = 25;
            bool sortedPastRange = false;

            while (pages++ < MAX_PAGES && keep.Count < oversample && !sortedPastRange)
            {
                string url = "https://api.twitch.tv/helix/streams?first=100&game_id=" + Uri.EscapeDataString(gameId);
                if (cursor != null) url += "&after=" + Uri.EscapeDataString(cursor);

                var resp = http.GetAsync(url).GetAwaiter().GetResult();
                CPH.LogInfo("[SF rf v5] page " + pages + " /helix/streams status=" + (int)resp.StatusCode);
                if (!resp.IsSuccessStatusCode)
                {
                    string errBody = "";
                    try { errBody = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult(); } catch {}
                    CPH.LogWarn("[SF rf v5] /helix/streams failed status=" + (int)resp.StatusCode + " body=" + (errBody.Length > 200 ? errBody.Substring(0, 200) : errBody));
                    BroadcastErr(reqId, "helix_" + (int)resp.StatusCode);
                    return true;
                }

                var body = JObject.Parse(resp.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                var streams = body["data"] as JArray;
                if (streams == null || streams.Count == 0) break;

                foreach (var s in streams)
                {
                    scanned++;
                    int v = s["viewer_count"] != null ? s["viewer_count"].Value<int>() : 0;
                    if (v > maxViewers) continue;     // not yet in range, keep paging down
                    if (v < minViewers) {              // sorted past the bottom — done
                        sortedPastRange = true;
                        break;
                    }
                    keep.Add(new JObject {
                        ["user_id"]       = s["user_id"],
                        ["user_login"]    = s["user_login"],
                        ["user_name"]     = s["user_name"],
                        ["title"]         = s["title"],
                        ["viewer_count"]  = v,
                        ["language"]      = s["language"],
                        ["started_at"]    = s["started_at"],
                        ["thumbnail_url"] = s["thumbnail_url"],
                        ["is_mature"]     = s["is_mature"]
                    });
                    if (keep.Count >= oversample) break;
                }

                var pag = body["pagination"];
                cursor = pag != null && pag["cursor"] != null ? pag["cursor"].Value<string>() : null;
                CPH.LogInfo("[SF rf v5] page " + pages + " scanned-so-far=" + scanned + " kept=" + keep.Count + " sortedPast=" + sortedPastRange + " hasCursor=" + (!string.IsNullOrEmpty(cursor)));
                if (string.IsNullOrEmpty(cursor)) break;
            }

            // Batch-fetch avatars via Helix /users
            if (keep.Count > 0)
            {
                var ids = keep.Select(j => j["user_id"].Value<string>()).Distinct().ToList();
                for (int i = 0; i < ids.Count; i += 100)
                {
                    var batch = ids.Skip(i).Take(100);
                    string uurl = "https://api.twitch.tv/helix/users?" + string.Join("&", batch.Select(id => "id=" + Uri.EscapeDataString(id)));
                    var uresp = http.GetAsync(uurl).GetAwaiter().GetResult();
                    if (uresp.IsSuccessStatusCode)
                    {
                        var ubody = JObject.Parse(uresp.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                        var udata = ubody["data"] as JArray;
                        if (udata != null)
                        {
                            var avatarMap = new Dictionary<string, string>();
                            foreach (var u in udata)
                            {
                                string uid = u["id"] != null ? u["id"].Value<string>() : "";
                                string pic = u["profile_image_url"] != null ? u["profile_image_url"].Value<string>() : "";
                                if (!string.IsNullOrEmpty(uid)) avatarMap[uid] = pic;
                            }
                            foreach (var s in keep)
                            {
                                string sid = s["user_id"].Value<string>();
                                if (avatarMap.ContainsKey(sid)) s["profile_image_url"] = avatarMap[sid];
                            }
                        }
                    }
                }
            }

            // Sort the oversampled set by closeness to the midpoint of the
            // target viewer range, then take wantCount. v3 sliced before
            // this sort, which biased toward the top of the range.
            int mid = (minViewers + maxViewers) / 2;
            var sorted = keep.OrderBy(j => Math.Abs(j["viewer_count"].Value<int>() - mid))
                             .Take(wantCount)
                             .ToList();
            var outArr = new JArray(sorted.ToArray());

            var payload = new JObject {
                ["source"]    = "sf_raid_finder",
                ["kind"]      = "results",
                ["reqId"]     = reqId,
                ["gameId"]    = gameId,         // resolved id (echoed for SF cache)
                ["gameName"]  = gameName,       // resolved name (echoed for SF cache)
                ["streams"]   = outArr,
                // Diagnostics — surfaced in SF when 0 results so the
                // streamer can tell "no streamers in your range" from
                // "API hit a wall". Doesn't affect happy-path UI.
                ["scanned"]   = scanned,
                ["pages"]     = pages,
                ["inRange"]   = keep.Count,
                ["pagesCap"]  = MAX_PAGES,
                ["hitCap"]    = !sortedPastRange && (keep.Count < oversample) && (pages >= MAX_PAGES)
            };
            CPH.LogInfo("[SF rf v5] broadcasting results reqId=" + reqId + " streams=" + sorted.Count + " scanned=" + scanned + " inRange=" + keep.Count);
            CPH.WebsocketBroadcastJson(payload.ToString(Newtonsoft.Json.Formatting.None));
            return true;
        }
    }

    private void BroadcastErr(string reqId, string code)
    {
        CPH.LogWarn("[SF rf v5] BroadcastErr reqId=" + reqId + " code=" + code);
        var p = new JObject {
            ["source"] = "sf_raid_finder",
            ["kind"]   = "error",
            ["reqId"]  = reqId,
            ["code"]   = code
        };
        CPH.WebsocketBroadcastJson(p.ToString(Newtonsoft.Json.Formatting.None));
    }
}
"""

# Start Raid action — unchanged from v2
RAID_CSHARP = r"""using System;

public class CPHInline
{
    public bool Execute()
    {
        string target = args.ContainsKey("raidTarget") ? args["raidTarget"].ToString() : "";
        if (string.IsNullOrEmpty(target))
        {
            CPH.LogWarn("[SF Raid Finder] No raidTarget provided.");
            return false;
        }
        bool ok = CPH.TwitchStartRaidByName(target);
        CPH.SetArgument("startRaidSuccess", ok);
        return true;
    }
}
"""

FULL_REFS = [
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\mscorlib.dll",
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.dll",
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Core.dll",
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Net.Http.dll",
    r".\Newtonsoft.Json.dll",
]
MIN_REFS = [
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\mscorlib.dll",
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.dll",
]

# Stable UUIDs sourced from index.html (SF_RF_FIND_UUID + SF_RF_RAID_UUID).
# Pre-v5 the build script generated fresh uuid.uuid4() values on every
# run, which meant a streamer who re-imported after a SF update wound
# up with the OLD action sitting next to the NEW action (different
# UUIDs, same name) — and SB resolved DoAction by ID, hitting the
# stale broken copy. Reading from index.html keeps both halves of the
# import lockstep with whatever SF's hard-coded matchers expect, so
# re-import overwrites the existing actions in place. Sub-action UUIDs
# don't need to be stable (SF doesn't reference them); we still
# stabilise them off the top UUID so the entire SBAE is reproducible.
HTML_PATH = pathlib.Path(__file__).resolve().parent.parent / "index.html"
_html = HTML_PATH.read_text(encoding="utf-8")
_find_match = re.search(r"var SF_RF_FIND_UUID = '([0-9a-f-]+)'", _html)
_raid_match = re.search(r"var SF_RF_RAID_UUID = '([0-9a-f-]+)'", _html)
if not _find_match or not _raid_match:
    sys.exit("could not find SF_RF_FIND_UUID/SF_RF_RAID_UUID in index.html — check selectors")
FIND_TOP_UUID = _find_match.group(1)
RAID_TOP_UUID = _raid_match.group(1)
# Deterministic sub-UUIDs derived from the top UUIDs so the SBAE is
# reproducible on rebuild without changing what SF resolves.
FIND_SUB_UUID = FIND_TOP_UUID[:-1] + ("0" if FIND_TOP_UUID[-1] != "0" else "1")
RAID_SUB_UUID = RAID_TOP_UUID[:-1] + ("0" if RAID_TOP_UUID[-1] != "0" else "1")

def _b64(text):
    return base64.b64encode(text.replace("\n", "\r\n").encode("utf-8")).decode("ascii")

doc = {
    "version": 23,
    "importVersion": 2,
    "minimumVersion": "0.2.0",
    "meta": {
        "name": "StreamFusion Raid Finder",
        "author": "StreamFusion",
        "version": "4.0.0",
        "description": "Two actions for the StreamFusion Raid Finder: searches Twitch for raid targets (with name→id resolution and smart pagination) and starts raids. Import this into Streamer.bot — no manual setup needed.",
        "autoRunAction": None,
        "minimumVersion": None,
    },
    "exportedFrom": "1.0.4",
    "data": {
        "actions": [
            {
                "id": FIND_TOP_UUID,
                "queue": "00000000-0000-0000-0000-000000000000",
                "enabled": True,
                "excludeFromHistory": False,
                "excludeFromPending": False,
                "name": "StreamFusion Raid Finder — Find Targets",
                "group": "StreamFusion",
                "alwaysRun": False,
                "randomAction": False,
                "concurrent": False,
                "triggers": [],
                "actions": [
                    {
                        "name": "SF Raid Finder — Find Targets",
                        "description": "Searches Twitch Helix for live streams matching the game and viewer range, then broadcasts results back to StreamFusion via WebSocket. Resolves game name to game id when needed.",
                        "keepAlive": False,
                        "references": FULL_REFS,
                        "byteCode": _b64(FIND_CSHARP),
                        "precompile": False,
                        "delayStart": False,
                        "saveResultToVariable": False,
                        "saveToVariable": "",
                        "id": FIND_SUB_UUID,
                        "weight": 0,
                        "type": 99999,
                        "group": None,
                        "enabled": True,
                        "index": 0,
                    }
                ],
                "subActions": [],
                "collapsedGroups": [],
            },
            {
                "id": RAID_TOP_UUID,
                "queue": "00000000-0000-0000-0000-000000000000",
                "enabled": True,
                "excludeFromHistory": False,
                "excludeFromPending": False,
                "name": "StreamFusion Raid Finder — Start Raid",
                "group": "StreamFusion",
                "alwaysRun": False,
                "randomAction": False,
                "concurrent": False,
                "triggers": [],
                "actions": [
                    {
                        "name": "SF Raid Finder — Start Raid",
                        "description": "Starts a Twitch raid to the target specified by StreamFusion.",
                        "keepAlive": False,
                        "references": MIN_REFS,
                        "byteCode": _b64(RAID_CSHARP),
                        "precompile": False,
                        "delayStart": False,
                        "saveResultToVariable": False,
                        "saveToVariable": "",
                        "id": RAID_SUB_UUID,
                        "weight": 0,
                        "type": 99999,
                        "group": None,
                        "enabled": True,
                        "index": 0,
                    }
                ],
                "subActions": [],
                "collapsedGroups": [],
            },
        ],
        "queues": [],
        "commands": [],
        "websocketServers": [],
        "websocketClients": [],
        "timers": [],
    },
}

out_json = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
buf = io.BytesIO()
with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as gz:
    gz.write(out_json)
sbae = b"SBAE" + buf.getvalue()
b64 = base64.b64encode(sbae).decode("ascii")

with open("scripts/sf-rf-import-new.txt", "w", encoding="utf-8") as f:
    f.write(b64)

print(f"v5 SBAE built: {len(b64)} chars (action C# now logs to SB Logs at every step)")
print(f"FIND_TOP_UUID = '{FIND_TOP_UUID}' (sourced from index.html — stable)")
print(f"RAID_TOP_UUID = '{RAID_TOP_UUID}' (sourced from index.html — stable)")

# Round-trip sanity
import zlib
raw = base64.b64decode(b64)
verify = json.loads(zlib.decompress(raw[4:], wbits=31).decode("utf-8"))
for top in verify["data"]["actions"]:
    sub = top["actions"][0]
    print(f"  '{top['name']}'  refs={len(sub['references'])}  bytecode={len(sub['byteCode'])} chars")
