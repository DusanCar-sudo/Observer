import json, subprocess, glob, os
from collections import Counter

files = sorted(glob.glob(os.path.expanduser('~/.dsh/sessions/*/*/session.v4.jsonl.zstd')))
print('v4 files:', len(files))

def decode(f):
    out = subprocess.run(['zstd','-dc',f], capture_output=True)
    return out.stdout.decode('utf-8', errors='replace').splitlines()

# structure of key records from one big session
f = max(files, key=os.path.getsize)
print('largest:', f, os.path.getsize(f))
seen = set()
for line in decode(f):
    try: rec = json.loads(line)
    except Exception: continue
    t = rec.get('type')
    if t in ('tool/call','tool/result','assistant/message','todo/write','turn/start','turn/end','session') and t not in seen:
        seen.add(t)
        s = json.dumps(rec)
        print('\n===', t, '===')
        print(s[:1500])

# census: turns, steps, tool calls, origin per session
print('\n\n=== CENSUS ===')
rows = []
for fp in files:
    sess = None
    ncall = nres = 0
    turns = set(); steps = set()
    turnvals = Counter()
    origin = None; depth = None
    ntodo = 0
    for line in decode(fp):
        try: rec = json.loads(line)
        except Exception: continue
        t = rec.get('type')
        if t == 'session':
            sess = rec
            origin = rec.get('origin'); depth = rec.get('delegationDepth')
        elif t == 'tool/call':
            ncall += 1
            d = rec.get('data', {})
            if d.get('turn') is not None: turns.add(d['turn'])
            if d.get('step') is not None: steps.add((d.get('turn'), d.get('step')))
        elif t == 'tool/result': nres += 1
        elif t == 'todo/write': ntodo += 1
    rows.append(dict(path=fp, id=(sess or {}).get('id'), cwd=(sess or {}).get('cwd'),
                     origin=origin, depth=depth, calls=ncall, results=nres,
                     turns=len(turns), steps=len(steps), todos=ntodo))
rows.sort(key=lambda r: -r['calls'])
for r in rows:
    print(f"{r['calls']:5d} calls {r['results']:5d} res {r['turns']:4d} turns {r['steps']:5d} steps todos={r['todos']:3d} depth={r['depth']} origin={r['origin']} {r['id']}")
print('\ntotal sessions:', len(rows))
print('with >=20 calls:', sum(1 for r in rows if r['calls'] >= 20))
print('with any todo/write:', sum(1 for r in rows if r['todos'] > 0))
print('origin values:', Counter(r['origin'] for r in rows))
print('depth values:', Counter(r['depth'] for r in rows))
