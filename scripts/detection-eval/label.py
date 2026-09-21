"""Write ground-truth labels, and synthesise known-positive cases."""
import json, os, subprocess, shutil
cases={c["id"]:c for c in json.load(open("cases.json"))}
# Ground truth established by LOOKING at the frames. expect = number of real
# continuity errors a careful human would say are MISTAKES (not intended).
LABELS={
 "case00":(0,"high","Same black coat both shots; he is prone in A (coat tail in the mud, lower half out of frame) and kneeling in B. Owner confirmed: it has always been a coat."),
 "case01":(0,"high","Same desert, same burning vehicle. B is a scope POV at a later moment (fireball has become a smoke column). Framing + time progression."),
 "case02":(0,"medium","Same monochrome illustration style throughout; A sparse/dark, B dense/bright is compositional escalation in a title montage."),
 "case04":(0,"high","Same warm interior, continuous action: hands holding the bat, then placing it in the case. Close-up to wider."),
 "case05":(0,"high","Doors physically open between B0 and B1 revealing the garden. A deliberate transition to a new location."),
 "case06":(0,"high","Same cosplayer, same dressing room, same costume and white balance. Close-up cut to wide; apparent exposure difference is shot scale."),
 "case10":(0,"high","Crayon drawing to kids at the window. Storm clearing to sunshine inside B is intended story beat. Correctly clean in production."),
}
out=[]
for cid,(exp,conf,why) in LABELS.items():
    c=cases[cid]; c["expected_errors"]=exp; c["confidence"]=conf; c["rationale"]=why
    c["kind"]="real"; c["frames"]={"A":[],"B":[]}
    out.append(c)

# --- synthetic positives: take clean pairs, push shot B's grade by a known amount
os.makedirs("frames",exist_ok=True)
def regrade(src,dst,args):
    subprocess.run(["ffmpeg","-y","-v","error","-i",src,"-vf",args,dst],check=True)
SYN=[("case08","lighting","eq=brightness=-0.22:saturation=0.45,colorbalance=rs=-0.25:bs=0.30",
      "Shot B pushed 0.22 darker, desaturated to 0.45 and shifted strongly cool — a grade mismatch no cut would survive."),
     ("case11","lighting","eq=brightness=0.18:saturation=1.5,colorbalance=rs=0.35:bs=-0.30",
      "Shot B pushed 0.18 brighter, saturation 1.5x and strongly warm."),
     ("case13","lighting","eq=brightness=-0.18:contrast=1.6,colorbalance=bs=0.35",
      "Shot B darkened, contrast 1.6x and pushed blue.")]
for cid,etype,filt,why in SYN:
    if cid not in cases: continue
    c=dict(cases[cid]); c["id"]=cid+"_syn"; c["kind"]="synthetic"
    c["expected_errors"]=1; c["expected_type"]=etype; c["confidence"]="high"; c["rationale"]=why
    fr={"A":[],"B":[]}
    for j in range(len(c["aFrames"][:2])):
        s=f"frames/{cid}_A{j}.jpg"
        if os.path.exists(s): fr["A"].append(s)
    for j in range(len(c["bFrames"][:2])):
        s=f"frames/{cid}_B{j}.jpg"; d=f"frames/{cid}_syn_B{j}.jpg"
        if os.path.exists(s):
            regrade(s,d,filt); fr["B"].append(d)
    if not fr["A"] or not fr["B"]: continue
    c["frames"]=fr
    out.append(c)
# real cases use their original local frames
for c in out:
    if c["kind"]!="real": continue
    cid=c["id"]
    c["frames"]={"A":[f"frames/{cid}_A{j}.jpg" for j in range(len(c['aFrames'][:2])) if os.path.exists(f"frames/{cid}_A{j}.jpg")],
                 "B":[f"frames/{cid}_B{j}.jpg" for j in range(len(c['bFrames'][:2])) if os.path.exists(f"frames/{cid}_B{j}.jpg")]}
json.dump(out,open("eval_set.json","w"),indent=1)
neg=sum(1 for c in out if c["expected_errors"]==0); pos=len(out)-neg
print(f"eval set: {len(out)} cases — {neg} negative (expect 0 errors), {pos} positive (expect >=1)")
for c in out: print(f"  {c['id']:14s} kind={c['kind']:9s} expect={c['expected_errors']}  A={len(c['frames']['A'])} B={len(c['frames']['B'])}  prod_flagged={[f['type'] for f in c['flagged']]}")
