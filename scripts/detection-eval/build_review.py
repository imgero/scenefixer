"""Local review page: every labelled case, my call, and production's call."""
import json, base64, os, html
cases=[c for c in json.load(open("eval_set.json")) if c["kind"]=="real"]
rows=[]
for c in cases:
    sheet=c.get("sheet")
    if not sheet or not os.path.exists(sheet): continue
    b64=base64.b64encode(open(sheet,'rb').read()).decode()
    prod=c["flagged"]
    prod_html=("".join(f"<li><b>{html.escape(f['type'])}</b>"
               f"{' <span class=paid>· user paid for this</span>' if f.get('userConfirmed') else ''}"
               f"<br><span class=d>{html.escape((f.get('description') or '')[:260])}</span></li>"
               for f in prod) or "<li class=none>nothing flagged</li>")
    rows.append(f"""
    <section>
      <h2>{c['id']} <span class=job>job {html.escape(c['job'][:14])} · shots {html.escape(c['a'])} vs {html.escape(c['b'])}</span></h2>
      <img src="data:image/jpeg;base64,{b64}" alt="{c['id']}">
      <div class=cols>
        <div class=card>
          <h3>What production reported</h3>
          <ul>{prod_html}</ul>
        </div>
        <div class=card>
          <h3>My label — <b class=verdict>{c['expected_errors']} real error(s)</b>
              <span class=conf>{c['confidence']} confidence</span></h3>
          <p>{html.escape(c['rationale'])}</p>
        </div>
      </div>
      <p class=ask>Agree that this is <b>{c['expected_errors']} real error(s)</b>? If not, say so — the whole measurement rests on these calls.</p>
    </section>""")
doc=f"""<!doctype html><meta charset=utf-8><title>Detection labels — review</title>
<style>
 :root{{color-scheme:light dark;--bg:#fff;--fg:#111;--mut:#666;--line:#e3e3e3;--card:#fafafa}}
 @media(prefers-color-scheme:dark){{:root{{--bg:#121212;--fg:#eee;--mut:#9a9a9a;--line:#2c2c2c;--card:#1b1b1b}}}}
 body{{background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:1000px;margin:0 auto;padding:32px 16px}}
 h1{{font-size:26px;margin:0 0 6px}} .sub{{color:var(--mut);margin:0 0 28px}}
 section{{border-top:1px solid var(--line);padding:26px 0}}
 h2{{font-size:19px;margin:0 0 12px}} .job{{font-weight:400;color:var(--mut);font-size:13px}}
 img{{width:100%;border-radius:8px;display:block;background:#000}}
 .cols{{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}}
 @media(max-width:700px){{.cols{{grid-template-columns:1fr}}}}
 .card{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}}
 h3{{font-size:14px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}}
 ul{{margin:0;padding-left:18px}} li{{margin-bottom:8px}}
 .d{{color:var(--mut);font-size:13px}} .none{{color:var(--mut);list-style:none;margin-left:-18px}}
 .paid{{color:#c0392b;font-size:12px}} .verdict{{color:#1a7f37}} .conf{{color:var(--mut);font-weight:400;font-size:12px}}
 .ask{{margin:12px 0 0;font-size:14px;color:var(--mut)}}
 .key{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:8px}}
</style>
<h1>Detection labels — please check my work</h1>
<p class=sub>Production flags an error on {sum(1 for c in cases if c['flagged'])} of these {len(cases)} pairs. I labelled all of them as having none.
If I am right, detection is running at an 81% false-positive rate. If I am wrong anywhere, the number moves.</p>
<div class=key><b>How to read a sheet:</b> top row is <b>Shot A</b> (the earlier shot, used as the reference),
bottom row is <b>Shot B</b> (the shot under review). Two frames each, sampled across the shot.
These frames are the <i>entire</i> input the detector gets — it never sees motion or audio.
<br><br><b>The question:</b> is the difference between A and B a <i>mistake nobody intended</i>,
or is it the scene doing its job — a different lens, a POV, time passing, the action moving on?</div>
{''.join(rows)}
<section><p class=sub>Frames are real user footage and stay on this machine — this file is local and not published.</p></section>
"""
open("review.html","w").write(doc)
print(f"wrote review.html ({len(doc)//1024} KB, {len(rows)} cases)")
