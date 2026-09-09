import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
initializeApp({credential:cert({projectId:env.FIREBASE_ADMIN_PROJECT_ID,clientEmail:env.FIREBASE_ADMIN_CLIENT_EMAIL,privateKey:env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g,"\n")})});
const db=getFirestore(); const ref=db.collection("jobs").doc("odnit6zfn623ay6y8j1ted2i");
for(let i=0;i<160;i++){
  const j=(await ref.get()).data();
  if(["awaiting_confirmation","error","done"].includes(j.status)){
    console.log("FINAL status:",j.status,"| shots:",j.shotCount,"| errors:",j.errorCount,"| scoreBefore:",j.scoreBefore);
    console.log("errorMessage:", j.errorMessage ?? "(none)");
    const errs=(await ref.collection("errors").get()).docs;
    console.log(`\n${errs.length} errors:\n`);
    for(const d of errs){const e=d.data();
      console.log(`  [${e.type}/${e.severity}] repairable=${e.repairable}${e.notRepairableReason?"  ("+e.notRepairableReason+")":""}`);
      console.log(`     ${(e.description||"").slice(0,150)}`);
      console.log(`     fix: ${(e.fixSuggestion||"").slice(0,125)}\n`);
    }
    process.exit(0);
  }
  await new Promise(r=>setTimeout(r,20000));
}
console.log("still running after ~53min");
