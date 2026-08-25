import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import fs from "fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
initializeApp({credential:cert({projectId:env.FIREBASE_ADMIN_PROJECT_ID,clientEmail:env.FIREBASE_ADMIN_CLIENT_EMAIL,privateKey:env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g,"\n")}),storageBucket:env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET});
const db=getFirestore(), bucket=getStorage().bucket();
const ts=v=>v?.toMillis?v.toMillis():(typeof v==="number"?v:0);
const jobs=(await db.collection("jobs").get()).docs.filter(d=>ts(d.data().createdAt)>Date.parse("2026-07-20"));
const out=[];
for(const d of jobs){
  const j=d.data();
  const zero = j.status!=="uploading" && j.status!=="error" && (j.shotCount??0)===0;
  const stuck = j.status==="uploading";
  if(!zero && !stuck) continue;
  // find the storage object for this job
  let meta=null, path=null;
  try{
    const [files]=await bucket.getFiles({prefix:`jobs/${d.id}/`});
    const inp=files.find(f=>!f.name.includes("/keyframes/")&&!f.name.includes("/clips/")&&/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name)) || files[0];
    if(inp){ path=inp.name; const [m]=await inp.getMetadata(); meta={size:Number(m.size),ct:m.contentType,created:m.timeCreated}; }
  }catch(e){}
  out.push({id:d.id, kind: stuck?"STUCK_UPLOADING":"ZERO_SHOTS", created:new Date(ts(j.createdAt)).toISOString().slice(0,16),
    owner: j.ownerUid?"user":(j.betaToken?"beta":"none"), hasUrl: !!j.inputVideoUrl, path, meta, errorMessage: j.errorMessage??null});
}
fs.writeFileSync("/tmp/diag.json", JSON.stringify(out,null,1));
for(const r of out){
  console.log(`${r.kind}  ${r.id}  ${r.created}  owner=${r.owner}  inputVideoUrl=${r.hasUrl?"yes":"NO"}`);
  console.log(`   storage: ${r.path? `${r.path}  ${r.meta?((r.meta.size/1048576).toFixed(2)+" MB  "+r.meta.ct):"(no meta)"}` : "NO OBJECT IN BUCKET"}`);
}
