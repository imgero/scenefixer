import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import fs from "fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
initializeApp({credential:cert({projectId:env.FIREBASE_ADMIN_PROJECT_ID,clientEmail:env.FIREBASE_ADMIN_CLIENT_EMAIL,privateKey:env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g,"\n")})});
const db=getFirestore();
const J="odnit6zfn623ay6y8j1ted2i";
const ref=db.collection("jobs").doc(J);

// snapshot everything first
const job=(await ref.get()).data();
const snap={job:{...job, createdAt:String(job.createdAt)}, shots:{}, errors:{}};
for(const c of ["shots","errors","verify_errors"]){
  for(const d of (await ref.collection(c).get()).docs) (snap[c] ||= {})[d.id]=JSON.parse(JSON.stringify(d.data()));
}
fs.writeFileSync("/private/tmp/claude-501/-Users-alanany-Desktop-Scene-Fixer/804f107d-2b30-4e2a-92d4-229f859b20aa/scratchpad/adreem_snapshot.json", JSON.stringify(snap,null,1));
console.log("snapshot saved — shots:", Object.keys(snap.shots||{}).length, "errors:", Object.keys(snap.errors||{}).length);

// clear derived data; detection uses .add() so stale errors would otherwise pile up
let n=0;
for(const c of ["shots","errors","verify_errors"]){
  for(const d of (await ref.collection(c).get()).docs){ await d.ref.delete(); n++; }
}
console.log("cleared", n, "derived docs");

await ref.update({
  status:"decomposing", shotCount:0, errorCount:0, fixedCount:0,
  scoreBefore:FieldValue.delete(), scoreAfter:FieldValue.delete(),
  verificationPassed:FieldValue.delete(), verifyWarning:FieldValue.delete(),
  outputVideoUrl:FieldValue.delete(), errorMessage:FieldValue.delete(),
  fixesAttempted:FieldValue.delete(), fixesVerified:FieldValue.delete(),
  fixesUnverified:FieldValue.delete(), fixesFailed:FieldValue.delete(),
  creditsRefunded:FieldValue.delete(), fixingStartedAt:FieldValue.delete(),
});
console.log("job reset -> decomposing | input:", (job.inputVideoUrl||"").slice(-46));

const res=await fetch(env.MODAL_PROCESS_JOB_URL,{method:"POST",
  headers:{"Content-Type":"application/json",Authorization:`Bearer ${env.MODAL_BEARER_TOKEN}`},
  body:JSON.stringify({jobId:J})});
console.log("process_job ->", res.status, (await res.text()).slice(0,120));
