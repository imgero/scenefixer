"""Pick a stratified sample of pairs and build one contact sheet per pair."""
import json, os, random, urllib.request, subprocess
random.seed(7)
P=json.load(open("candidates.json"))
flagged=[p for p in P if p["flagged"]]
clean=[p for p in P if not p["flagged"]]
# bias toward recent (list already sorted newest-first) but keep spread
pick = flagged[:4] + random.sample(flagged[4:], 4) + clean[:2] + random.sample(clean[2:], 4)
os.makedirs("frames",exist_ok=True); os.makedirs("sheets",exist_ok=True)
def grab(url,dst):
    if os.path.exists(dst) and os.path.getsize(dst)>1000: return True
    try: urllib.request.urlretrieve(url,dst); return True
    except Exception as e: print("  fail",e); return False
cases=[]
for i,p in enumerate(pick):
    cid=f"case{i:02d}"
    af=[u for u in p["aFrames"][:2]]; bf=[u for u in p["bFrames"][:2]]
    paths=[]
    ok=True
    for j,u in enumerate(af):
        d=f"frames/{cid}_A{j}.jpg"; ok &= grab(u,d); paths.append(d)
    for j,u in enumerate(bf):
        d=f"frames/{cid}_B{j}.jpg"; ok &= grab(u,d); paths.append(d)
    if not ok or len(paths)<2: continue
    sheet=f"sheets/{cid}.jpg"
    n=len(paths)
    inputs=[]; 
    for pth in paths: inputs += ["-i",pth]
    # label each: A frames top, B frames bottom
    filt="".join(f"[{k}:v]scale=480:-1,drawtext=text='{'A' if k<len(af) else 'B'}{k if k<len(af) else k-len(af)}':x=8:y=8:fontsize=34:fontcolor=yellow:box=1:boxcolor=black@0.6[v{k}];" for k in range(n))
    top="".join(f"[v{k}]" for k in range(len(af)))+f"hstack=inputs={len(af)}[top];"
    bot="".join(f"[v{k}]" for k in range(len(af),n))+f"hstack=inputs={n-len(af)}[bot];"
    filt+=top+bot+"[top][bot]vstack=inputs=2[out]"
    r=subprocess.run(["ffmpeg","-y","-v","error",*inputs,"-filter_complex",filt,"-map","[out]",sheet],capture_output=True)
    if r.returncode!=0:
        print(cid,"sheet fail",r.stderr.decode()[-200:]); continue
    cases.append({"id":cid,"job":p["job"],"a":p["a"],"b":p["b"],"hint":p["hint"],
                  "flagged":p["flagged"],"sheet":sheet,
                  "aFrames":af,"bFrames":bf,"label":None})
json.dump(cases,open("cases.json","w"),indent=1)
print(f"built {len(cases)} contact sheets")
for c in cases:
    ft=[f"{f['type']}{'*' if f['userConfirmed'] else ''}" for f in c["flagged"]]
    print(f"  {c['id']}  job={c['job'][:12]}  shipped_findings={ft or '[]'}")
