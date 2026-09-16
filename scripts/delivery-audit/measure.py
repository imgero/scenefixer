import json, subprocess, sys, os, math, struct

def luma_series(path):
    esc = path.replace(":", "\\:")
    r = subprocess.run(["ffprobe","-v","error","-f","lavfi","-i",
        f"movie={esc},signalstats","-show_entries","frame=pts_time:frame_tags=lavfi.signalstats.YAVG",
        "-of","csv=p=0"], capture_output=True, text=True)
    out=[]
    for l in r.stdout.splitlines():
        p=l.split(",")
        if len(p)>=2:
            try: out.append((float(p[0]), float(p[1])))
            except ValueError: pass
    return out

def seg_mean(series, a, b):
    v=[y for t,y in series if a<=t<b]
    return sum(v)/len(v) if v else None

def geom(path):
    r=subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=width,height",
        "-of","csv=p=0:s=x",path],capture_output=True,text=True)
    n=subprocess.run(["ffprobe","-v","error","-count_frames","-select_streams","v:0",
        "-show_entries","stream=nb_read_frames","-of","csv=p=0",path],capture_output=True,text=True)
    return r.stdout.strip(), n.stdout.strip()

def env(f):
    d=subprocess.run(['ffmpeg','-v','error','-i',f,'-map','0:a:0','-ac','1','-ar','8000','-f','s16le','-'],capture_output=True).stdout
    n=len(d)//2
    if n==0: return []
    s=struct.unpack('<%dh'%n,d[:n*2]); w=80
    return [math.sqrt(sum(x*x for x in s[i:i+w])/max(1,len(s[i:i+w]))) for i in range(0,n-w,w)]

def sync(ref, other):
    a,b = env(ref), env(other)
    if not a or not b: return "no audio"
    best=None
    for lag in range(-25,26):
        xs=[];ys=[]
        for i in range(len(a)):
            j=i+lag
            if 0<=j<len(b): xs.append(a[i]); ys.append(b[j])
        if len(xs)<20: continue
        ma=sum(xs)/len(xs); mb=sum(ys)/len(ys)
        num=sum((x-ma)*(y-mb) for x,y in zip(xs,ys))
        den=math.sqrt(sum((x-ma)**2 for x in xs)*sum((y-mb)**2 for y in ys))
        c=num/den if den else 0
        if best is None or c>best[1]: best=(lag,c)
    return "%+d ms  corr %.4f" % (best[0]*10, best[1])

job=sys.argv[1]
d=json.load(open(f"cases/{job}/data.json"))
shots=sorted(d["shots"], key=lambda s:s["index"])
fixed_ids={e["shotBId"] if e.get("fixDirection","aTob")=="aTob" else e["shotAId"]
           for e in d["errors"] if e.get("fixStatus")=="fixed" and e.get("fixedClipUrl")
           and not e.get("autoRefunded") and (e.get("verifyResult") or {}).get("errorStillVisible") is not True}

files={"ORIGINAL":f"cases/{job}/input.mp4","OLD":f"{job}_OLD.mp4","NEW":f"{job}_NEW.mp4"}
series={k:luma_series(v) for k,v in files.items() if os.path.exists(v)}

print(f"\n=== {job} ===")
for k,v in files.items():
    if os.path.exists(v):
        g,n=geom(v); extra = "" if k=="ORIGINAL" else "   A/V vs original: "+sync(files["ORIGINAL"], v)
        print(f"  {k:9s} {g:>10s}  {n:>4s} frames{extra}")

print(f"\n  Seam steps at each fixed shot (|luma difference| across the cut; lower = less visible):")
print(f"  {'shot':<12}{'edge':<8}{'ORIGINAL':>10}{'OLD':>10}{'NEW':>10}")
for i,s in enumerate(shots):
    if s["__id"] not in fixed_ids: continue
    a,b = s["startMs"]/1000, s["endMs"]/1000
    prev = shots[i-1] if i>0 else None
    nxt  = shots[i+1] if i+1<len(shots) else None
    for label, other in (("in", prev), ("out", nxt)):
        if other is None: continue
        oa, ob = other["startMs"]/1000, other["endMs"]/1000
        row=[]
        for k in ("ORIGINAL","OLD","NEW"):
            if k not in series: row.append("-"); continue
            m1, m2 = seg_mean(series[k],a,b), seg_mean(series[k],oa,ob)
            row.append("%.2f" % abs(m1-m2) if m1 and m2 else "-")
        print(f"  {s['__id']:<12}{label:<8}{row[0]:>10}{row[1]:>10}{row[2]:>10}")
