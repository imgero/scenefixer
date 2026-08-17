import { NextRequest, NextResponse } from "next/server";
import { notifyOwner } from "@/lib/notify";

export async function POST(req: NextRequest) {
  const { email, userId } = await req.json();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const res = await fetch("https://app.loops.so/api/v1/contacts/create", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LOOPS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, userId, source: "signup" }),
  });

  notifyOwner(
    `[Scene Fixer] New sign-up — ${email}`,
    `New user signed up.\n\nEmail: ${email}\nUID: ${userId}\nTime: ${new Date().toUTCString()}`
  );

  const data = await res.json();
  return NextResponse.json(data, { status: res.ok ? 200 : res.status });
}
