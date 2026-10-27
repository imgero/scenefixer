import { NextResponse } from "next/server";
import { LAB_COOKIE } from "@/lib/lab/auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(LAB_COOKIE, "", { httpOnly: true, path: "/", expires: new Date(0) });
  return res;
}
