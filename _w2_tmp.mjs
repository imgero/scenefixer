import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
initializeApp({credential:cert({projectId:env.FIREBASE_ADMIN_PROJECT_ID,clientEmail:env.FIREBASE_ADMIN_CLIENT_EMAIL,privateKey:env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g,"\n")})});
const db=getFirestore(); const ref=db.collection("jobs").doc("odnit6zfn623ay6y8j1ted2i");
let last="";
for(let i=0;i<80;i++){
  const j=(await ref.get()).data();
  const line=`${j.status} shots=${j.shotCount} errors=${j.errorCount??"-"}`;
  if(line!==last){ console.log(new Date().toISOString().slice(11,19), line); last=line; }
  if(["awaiting_confirmation","error","done"].includes(j.status)){
    console.log("\nscoreBefore:", j.scoreBefore, "| errorMessage:", j.errorMessage ?? "(none)");
    const errs=(await ref.collection("errors").get()).docs;
    console.log(`\n${errs.length} errors detected:\n`);
    for(const d of errs){const e=d.data();
      console.log(`  [${e.type}/${e.severity}] repairable=${e.repairable}${e.notRepairableReason?" ("+e.notRepairableReason+")":""}`);
      console.log(`     ${(e.description||"").slice(0,150)}`);
      console.log(`     fix: ${(e.fixSuggestion||"").slice(0,130)}`);
    }
    break;
  }
  await new Promise(r=>setTimeout(r,15000));
}
