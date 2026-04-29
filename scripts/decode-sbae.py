"""Decode SF_RF_IMPORT to inspect the embedded SB action C# code."""
import base64, zlib, re, json, sys

with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

m = re.search(r"var SF_RF_IMPORT = '([^']+)'", html)
if not m: sys.exit('SF_RF_IMPORT not found')

data = base64.b64decode(m.group(1))
out = zlib.decompress(data[4:], wbits=31)

doc = json.loads(out.decode('utf-8'))

print('=== meta ===')
print(json.dumps(doc.get('meta'), indent=2))

actions = doc.get('data', {}).get('actions', [])
print(f'\n=== {len(actions)} top-level actions ===')

for a in actions:
    print(f'\n--- action: {a["name"]} ---')
    print(f'enabled={a.get("enabled")} group={a.get("group")} triggers={len(a.get("triggers", []))}')
    for sub in a.get('actions', []):
        print(f'  sub: {sub.get("name")} type={sub.get("type", "?")} keepAlive={sub.get("keepAlive")}')
        if 'byteCode' in sub:
            try:
                code = base64.b64decode(sub['byteCode']).decode('utf-8', errors='replace')
                print('  ── code ──')
                print('\n'.join('  ' + l for l in code.splitlines()))
                print('  ── end code ──')
            except Exception as e:
                print(f'  byteCode decode failed: {e}')
        else:
            for k, v in sub.items():
                if k == 'name': continue
                print(f'    {k}: {repr(v)[:200]}')
