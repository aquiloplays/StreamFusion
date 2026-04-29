"""Rebuild the StreamFusion Raid Finder SBAE import with the references
required for the inline C# action to actually compile in Streamer.bot.

Root cause of "Raid Finder doesn't work": the original SBAE shipped with
references=[mscorlib.dll] only, but the C# uses System.Linq (needs
System.Core.dll), HttpClient (needs System.Net.Http.dll), Newtonsoft.Json
(needs Newtonsoft.Json.dll), and System.dll. The action silently failed to
compile, so DoAction returned "ok" but no broadcast ever fired.

Cross-checked references against an existing working action in the user's
actions.json ("Discord Stream Logger | Stream Events") which uses the
same dependency set.

Action UUIDs are bumped to fresh values so re-import doesn't collide with
any pre-existing broken copy already imported in SB.
"""
import base64, gzip, json, io, struct, uuid

with open('scripts/sbae-decoded.json', 'r', encoding='utf-8') as f:
    doc = json.load(f)

# References needed for an HTTP + LINQ + Newtonsoft.Json inline C# action.
# Paths match the convention used elsewhere in the user's actions.json.
FULL_REFS = [
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\mscorlib.dll",
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.dll",
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Core.dll",
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Net.Http.dll",
    r".\Newtonsoft.Json.dll",
]
# Start Raid only needs mscorlib.dll + System.dll (no LINQ, no HTTP, no JSON).
# Keep it minimal so it works on stripped-down installs.
MIN_REFS = [
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\mscorlib.dll",
    r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.dll",
]

# Bump action UUIDs so re-import doesn't conflict with the broken copy
# users already imported. We keep the names the same (Find Targets / Start
# Raid) because StreamFusion's _rfCheckActions matches by name.
NEW_UUIDS = {
    "ce9bb91b-6107-4e85-a6cd-1469fe7242e7": str(uuid.uuid4()),  # Find Targets action
    "205a7870-346b-4cec-822c-132be168a104": str(uuid.uuid4()),  # Find Targets sub
    "dc8469d4-b674-49e4-89e2-49140a7c12a2": str(uuid.uuid4()),  # Start Raid action
    "1cd188d3-64c0-4680-a734-6455c845c873": str(uuid.uuid4()),  # Start Raid sub
}

def patch(node):
    if isinstance(node, dict):
        if node.get('id') in NEW_UUIDS:
            node['id'] = NEW_UUIDS[node['id']]
        for k, v in node.items():
            patch(v)
    elif isinstance(node, list):
        for item in node:
            patch(item)

patch(doc)

actions = doc['data']['actions']
for top in actions:
    name = top.get('name', '')
    is_find = 'Find Targets' in name
    for sub in top.get('actions', []):
        if 'references' in sub:
            sub['references'] = FULL_REFS if is_find else MIN_REFS
            print(f"updated refs on '{name}' / '{sub.get('name')}': {len(sub['references'])} entries")

# Re-encode: SBAE is "SBAE" magic + gzip-compressed UTF-8 JSON.
out_json = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode('utf-8')

# gzip with deterministic output (no mtime/filename/comment) — the original
# blob has the gzip header right after the SBAE magic.
buf = io.BytesIO()
with gzip.GzipFile(fileobj=buf, mode='wb', compresslevel=9, mtime=0) as gz:
    gz.write(out_json)
sbae = b'SBAE' + buf.getvalue()
b64 = base64.b64encode(sbae).decode('ascii')

print(f"\noutput size: {len(b64)} chars (was 4280)")
with open('scripts/sf-rf-import-new.txt', 'w', encoding='utf-8') as f:
    f.write(b64)
print("wrote scripts/sf-rf-import-new.txt")

# Sanity round-trip: decode our output and verify references match.
import zlib
raw = base64.b64decode(b64)
out = zlib.decompress(raw[4:], wbits=31).decode('utf-8')
verify = json.loads(out)
for top in verify['data']['actions']:
    for sub in top.get('actions', []):
        if 'references' in sub:
            print(f"verify '{top['name']}' refs: {len(sub['references'])}")
            for r in sub['references']:
                print(f"  {r}")
