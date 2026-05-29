"""Build the StreamFusion "Stream Info" Streamer.bot action bundle (SBAE).

Sibling of build-rf-sbae.py (the Raid Finder bundle). Ships three inline-C#
actions that StreamFusion's Stream Info panel drives over the existing
Streamer.bot WebSocket — no separate Twitch OAuth in SF. Each action uses
SB's own broadcaster login (CPH.TwitchClientId / CPH.TwitchOAuthToken) and
broadcasts its result back via CPH.WebsocketBroadcastJson tagged
`source = "sf_stream_info"`, which SF routes in handleSBEvent → _siHandleResponse.

  1. Get Channel Info   — GET  /helix/channels?broadcaster_id=  (+ /games?id= for box art)
  2. Update Channel Info — PATCH /helix/channels?broadcaster_id=  body {title, game_id, tags}
                           (requires the channel:manage:broadcast scope on the SB token)
  3. Search Categories  — GET  /helix/search/categories?query=  (autocomplete w/ box_art_url)

UUIDs are read from index.html (SF_SI_GET_UUID / SF_SI_SET_UUID / SF_SI_SEARCH_UUID)
so a re-import overwrites the existing actions in place rather than creating
duplicates beside an older copy — exactly the v5 lesson from the Raid Finder.

Output: scripts/sf-si-import.txt  (the base64 import string SF embeds as SF_SI_IMPORT).
"""
import base64, gzip, json, io, re, sys, pathlib

# ── 1. Get Channel Info ──────────────────────────────────────────────────────
GET_CSHARP = r"""using System;
using System.Net.Http;
using Newtonsoft.Json.Linq;

public class CPHInline
{
    public bool Execute()
    {
        string reqId         = args.ContainsKey("sfReqId")       ? args["sfReqId"].ToString()       : "unknown";
        string broadcasterId = args.ContainsKey("broadcasterId") ? args["broadcasterId"].ToString() : "";

        string clientId = CPH.TwitchClientId;
        string token    = CPH.TwitchOAuthToken;
        if (string.IsNullOrEmpty(clientId) || string.IsNullOrEmpty(token))
        {
            CPH.LogWarn("[SF si] twitch_not_connected — sign in to Twitch inside Streamer.bot first");
            BroadcastErr(reqId, "twitch_not_connected");
            return true;
        }

        using (var http = new HttpClient())
        {
            http.DefaultRequestHeaders.Add("Client-ID", clientId);
            http.DefaultRequestHeaders.Add("Authorization", "Bearer " + token);

            // SF normally supplies the broadcaster id from SB's GetBroadcaster.
            // If it couldn't, resolve the token's own user via /helix/users.
            if (string.IsNullOrEmpty(broadcasterId))
            {
                var ur = http.GetAsync("https://api.twitch.tv/helix/users").GetAwaiter().GetResult();
                if (ur.IsSuccessStatusCode)
                {
                    var ub = JObject.Parse(ur.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                    var ua = ub["data"] as JArray;
                    if (ua != null && ua.Count > 0 && ua[0]["id"] != null)
                        broadcasterId = ua[0]["id"].Value<string>();
                }
            }
            if (string.IsNullOrEmpty(broadcasterId))
            {
                BroadcastErr(reqId, "missing_broadcaster");
                return true;
            }

            string url = "https://api.twitch.tv/helix/channels?broadcaster_id=" + Uri.EscapeDataString(broadcasterId);
            var resp = http.GetAsync(url).GetAwaiter().GetResult();
            CPH.LogInfo("[SF si] GET /channels status=" + (int)resp.StatusCode);
            if (!resp.IsSuccessStatusCode)
            {
                BroadcastErr(reqId, "helix_" + (int)resp.StatusCode);
                return true;
            }

            var body = JObject.Parse(resp.Content.ReadAsStringAsync().GetAwaiter().GetResult());
            var arr  = body["data"] as JArray;
            JObject ch = (arr != null && arr.Count > 0) ? (JObject)arr[0] : new JObject();

            string title    = ch["title"]     != null ? ch["title"].Value<string>()     : "";
            string gameId   = ch["game_id"]   != null ? ch["game_id"].Value<string>()   : "";
            string gameName = ch["game_name"] != null ? ch["game_name"].Value<string>() : "";
            var    tagsArr  = ch["tags"] as JArray; if (tagsArr == null) tagsArr = new JArray();

            // Resolve the current category's box art so SF can show a thumbnail
            // without a second round-trip from the renderer.
            string boxArt = "";
            if (!string.IsNullOrEmpty(gameId))
            {
                var gr = http.GetAsync("https://api.twitch.tv/helix/games?id=" + Uri.EscapeDataString(gameId)).GetAwaiter().GetResult();
                if (gr.IsSuccessStatusCode)
                {
                    var gb = JObject.Parse(gr.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                    var ga = gb["data"] as JArray;
                    if (ga != null && ga.Count > 0 && ga[0]["box_art_url"] != null)
                        boxArt = ga[0]["box_art_url"].Value<string>();
                }
            }

            var payload = new JObject {
                ["source"]        = "sf_stream_info",
                ["kind"]          = "info",
                ["reqId"]         = reqId,
                ["broadcasterId"] = broadcasterId,
                ["title"]         = title,
                ["gameId"]        = gameId,
                ["gameName"]      = gameName,
                ["boxArtUrl"]     = boxArt,
                ["tags"]          = tagsArr
            };
            CPH.WebsocketBroadcastJson(payload.ToString(Newtonsoft.Json.Formatting.None));
            return true;
        }
    }

    private void BroadcastErr(string reqId, string code)
    {
        var p = new JObject {
            ["source"] = "sf_stream_info",
            ["kind"]   = "error",
            ["op"]     = "get",
            ["reqId"]  = reqId,
            ["code"]   = code
        };
        CPH.WebsocketBroadcastJson(p.ToString(Newtonsoft.Json.Formatting.None));
    }
}
"""

# ── 2. Update Channel Info ───────────────────────────────────────────────────
SET_CSHARP = r"""using System;
using System.Text;
using System.Net.Http;
using Newtonsoft.Json.Linq;

public class CPHInline
{
    public bool Execute()
    {
        string reqId         = args.ContainsKey("sfReqId")       ? args["sfReqId"].ToString()       : "unknown";
        string broadcasterId = args.ContainsKey("broadcasterId") ? args["broadcasterId"].ToString() : "";
        bool hasTitle  = args.ContainsKey("title");
        bool hasGame   = args.ContainsKey("gameId");
        bool hasTags   = args.ContainsKey("tags");
        string title   = hasTitle ? args["title"].ToString()  : null;
        string gameId  = hasGame  ? args["gameId"].ToString() : null;
        string tagsRaw = hasTags  ? args["tags"].ToString()   : null;   // pipe-delimited: "tag1|tag2"

        string clientId = CPH.TwitchClientId;
        string token    = CPH.TwitchOAuthToken;
        if (string.IsNullOrEmpty(clientId) || string.IsNullOrEmpty(token))
        {
            BroadcastErr(reqId, "twitch_not_connected", "");
            return true;
        }

        using (var http = new HttpClient())
        {
            http.DefaultRequestHeaders.Add("Client-ID", clientId);
            http.DefaultRequestHeaders.Add("Authorization", "Bearer " + token);

            if (string.IsNullOrEmpty(broadcasterId))
            {
                var ur = http.GetAsync("https://api.twitch.tv/helix/users").GetAwaiter().GetResult();
                if (ur.IsSuccessStatusCode)
                {
                    var ub = JObject.Parse(ur.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                    var ua = ub["data"] as JArray;
                    if (ua != null && ua.Count > 0 && ua[0]["id"] != null)
                        broadcasterId = ua[0]["id"].Value<string>();
                }
            }
            if (string.IsNullOrEmpty(broadcasterId))
            {
                BroadcastErr(reqId, "missing_broadcaster", "");
                return true;
            }

            var bodyObj = new JObject();
            if (hasTitle) bodyObj["title"]   = title;
            if (hasGame)  bodyObj["game_id"] = gameId;
            if (hasTags)
            {
                var tarr = new JArray();
                foreach (var t in tagsRaw.Split('|'))
                {
                    var tt = t.Trim();
                    if (tt.Length > 0) tarr.Add(tt);
                }
                bodyObj["tags"] = tarr;
            }

            var content = new StringContent(bodyObj.ToString(Newtonsoft.Json.Formatting.None), Encoding.UTF8, "application/json");
            var req = new HttpRequestMessage(new HttpMethod("PATCH"),
                "https://api.twitch.tv/helix/channels?broadcaster_id=" + Uri.EscapeDataString(broadcasterId));
            req.Content = content;

            var resp = http.SendAsync(req).GetAwaiter().GetResult();
            int code = (int)resp.StatusCode;
            CPH.LogInfo("[SF si] PATCH /channels status=" + code);

            // 204 No Content = success. 401 usually = the SB token lacks the
            // channel:manage:broadcast scope; SF surfaces a re-auth hint.
            if (code == 204 || code == 200)
            {
                var ok = new JObject {
                    ["source"]        = "sf_stream_info",
                    ["kind"]          = "updated",
                    ["reqId"]         = reqId,
                    ["broadcasterId"] = broadcasterId,
                    ["title"]         = title,
                    ["gameId"]        = gameId
                };
                CPH.WebsocketBroadcastJson(ok.ToString(Newtonsoft.Json.Formatting.None));
                return true;
            }

            string errBody = "";
            try { errBody = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult(); } catch {}
            CPH.LogWarn("[SF si] PATCH failed status=" + code + " body=" + (errBody.Length > 200 ? errBody.Substring(0, 200) : errBody));
            BroadcastErr(reqId, "helix_" + code, errBody.Length > 200 ? errBody.Substring(0, 200) : errBody);
            return true;
        }
    }

    private void BroadcastErr(string reqId, string code, string detail)
    {
        var p = new JObject {
            ["source"] = "sf_stream_info",
            ["kind"]   = "error",
            ["op"]     = "update",
            ["reqId"]  = reqId,
            ["code"]   = code,
            ["detail"] = detail
        };
        CPH.WebsocketBroadcastJson(p.ToString(Newtonsoft.Json.Formatting.None));
    }
}
"""

# ── 3. Search Categories (autocomplete) ──────────────────────────────────────
SEARCH_CSHARP = r"""using System;
using System.Net.Http;
using Newtonsoft.Json.Linq;

public class CPHInline
{
    public bool Execute()
    {
        string reqId = args.ContainsKey("sfReqId") ? args["sfReqId"].ToString() : "unknown";
        string query = args.ContainsKey("query")   ? args["query"].ToString()   : "";

        if (string.IsNullOrEmpty(query))
        {
            Broadcast(reqId, query, new JArray());
            return true;
        }

        string clientId = CPH.TwitchClientId;
        string token    = CPH.TwitchOAuthToken;
        if (string.IsNullOrEmpty(clientId) || string.IsNullOrEmpty(token))
        {
            BroadcastErr(reqId, "twitch_not_connected");
            return true;
        }

        using (var http = new HttpClient())
        {
            http.DefaultRequestHeaders.Add("Client-ID", clientId);
            http.DefaultRequestHeaders.Add("Authorization", "Bearer " + token);

            string url = "https://api.twitch.tv/helix/search/categories?first=12&query=" + Uri.EscapeDataString(query);
            var resp = http.GetAsync(url).GetAwaiter().GetResult();
            if (!resp.IsSuccessStatusCode)
            {
                BroadcastErr(reqId, "helix_" + (int)resp.StatusCode);
                return true;
            }

            var body = JObject.Parse(resp.Content.ReadAsStringAsync().GetAwaiter().GetResult());
            var data = body["data"] as JArray;
            var games = new JArray();
            if (data != null)
            {
                foreach (var g in data)
                {
                    games.Add(new JObject {
                        ["id"]        = g["id"],
                        ["name"]      = g["name"],
                        ["boxArtUrl"] = g["box_art_url"]
                    });
                }
            }
            Broadcast(reqId, query, games);
            return true;
        }
    }

    private void Broadcast(string reqId, string query, JArray games)
    {
        var p = new JObject {
            ["source"] = "sf_stream_info",
            ["kind"]   = "games",
            ["reqId"]  = reqId,
            ["query"]  = query,
            ["games"]  = games
        };
        CPH.WebsocketBroadcastJson(p.ToString(Newtonsoft.Json.Formatting.None));
    }

    private void BroadcastErr(string reqId, string code)
    {
        var p = new JObject {
            ["source"] = "sf_stream_info",
            ["kind"]   = "error",
            ["op"]     = "search",
            ["reqId"]  = reqId,
            ["code"]   = code
        };
        CPH.WebsocketBroadcastJson(p.ToString(Newtonsoft.Json.Formatting.None));
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

# Stable UUIDs sourced from index.html so a re-import overwrites in place.
HTML_PATH = pathlib.Path(__file__).resolve().parent.parent / "index.html"
_html = HTML_PATH.read_text(encoding="utf-8")

def _uuid(name):
    m = re.search(r"var " + name + r"\s*=\s*'([0-9a-f-]+)'", _html)
    if not m:
        sys.exit("could not find %s in index.html — add the constant first" % name)
    return m.group(1)

GET_TOP    = _uuid("SF_SI_GET_UUID")
SET_TOP    = _uuid("SF_SI_SET_UUID")
SEARCH_TOP = _uuid("SF_SI_SEARCH_UUID")

def _sub(u):
    return u[:-1] + ("0" if u[-1] != "0" else "1")

def _b64(text):
    return base64.b64encode(text.replace("\n", "\r\n").encode("utf-8")).decode("ascii")

def _action(top_uuid, name, csharp, desc):
    return {
        "id": top_uuid,
        "queue": "00000000-0000-0000-0000-000000000000",
        "enabled": True,
        "excludeFromHistory": False,
        "excludeFromPending": False,
        "name": name,
        "group": "StreamFusion",
        "alwaysRun": False,
        "randomAction": False,
        "concurrent": False,
        "triggers": [],
        "actions": [
            {
                "name": name,
                "description": desc,
                "keepAlive": False,
                "references": FULL_REFS,
                "byteCode": _b64(csharp),
                "precompile": False,
                "delayStart": False,
                "saveResultToVariable": False,
                "saveToVariable": "",
                "id": _sub(top_uuid),
                "weight": 0,
                "type": 99999,
                "group": None,
                "enabled": True,
                "index": 0,
            }
        ],
        "subActions": [],
        "collapsedGroups": [],
    }

doc = {
    "version": 23,
    "importVersion": 2,
    "minimumVersion": "0.2.0",
    "meta": {
        "name": "StreamFusion Stream Info",
        "author": "StreamFusion",
        "version": "1.0.0",
        "description": "Three actions powering the StreamFusion Stream Info panel: read current title/category/tags, update them, and search the Twitch category catalogue. Uses your existing Streamer.bot Twitch login — no extra tokens. Updating title/category needs the channel:manage:broadcast scope on that login.",
        "autoRunAction": None,
        "minimumVersion": None,
    },
    "exportedFrom": "1.0.4",
    "data": {
        "actions": [
            _action(GET_TOP,    "StreamFusion Stream Info — Get Channel Info",    GET_CSHARP,
                    "Reads the channel's current title, category and tags via Twitch Helix and broadcasts them back to StreamFusion."),
            _action(SET_TOP,    "StreamFusion Stream Info — Update Channel Info", SET_CSHARP,
                    "Applies a new title / category / tags via Twitch Helix PATCH /channels. Requires channel:manage:broadcast on the SB Twitch login."),
            _action(SEARCH_TOP, "StreamFusion Stream Info — Search Categories",   SEARCH_CSHARP,
                    "Autocompletes the Twitch category catalogue via /helix/search/categories and broadcasts matches (with box art) back to StreamFusion."),
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

out_path = pathlib.Path(__file__).resolve().parent / "sf-si-import.txt"
out_path.write_text(b64, encoding="utf-8")

print("Stream Info SBAE built: %d chars -> %s" % (len(b64), out_path))
print("GET_UUID    = '%s'" % GET_TOP)
print("SET_UUID    = '%s'" % SET_TOP)
print("SEARCH_UUID = '%s'" % SEARCH_TOP)

# Round-trip sanity
import zlib
raw = base64.b64decode(b64)
verify = json.loads(zlib.decompress(raw[4:], wbits=31).decode("utf-8"))
for top in verify["data"]["actions"]:
    sub = top["actions"][0]
    print("  '%s'  refs=%d  bytecode=%d chars" % (top["name"], len(sub["references"]), len(sub["byteCode"])))
