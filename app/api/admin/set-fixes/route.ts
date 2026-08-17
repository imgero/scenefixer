import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

// Simple secret guard — set ADMIN_SECRET in .env.local
const ADMIN_SECRET = process.env.ADMIN_SECRET;

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-admin-secret");
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { email, plan, creditsUsedThisMonth } = await req.json();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  // Find user by email
  const snap = await adminDb.collection("users").where("email", "==", email).limit(1).get();
  if (snap.empty) {
    return NextResponse.json({ error: `No user found with email ${email}` }, { status: 404 });
  }

  const userRef = snap.docs[0].ref;
  const updates: Record<string, unknown> = {};
  if (plan !== undefined) updates.plan = plan;
  if (creditsUsedThisMonth !== undefined) updates.creditsUsedThisMonth = creditsUsedThisMonth;

  await userRef.update(updates);
  const updated = (await userRef.get()).data();
  return NextResponse.json({ ok: true, updated });
}
