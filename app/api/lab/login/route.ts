import { NextRequest, NextResponse } from "next/server";
import { attemptLogin, LAB_COOKIE, makeToken } from "@/lib/lab/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { login?: string; password?: string } | null;
  if (!body?.login || !body?.password) return NextResponse.json({ error: "Enter the login and password" }, { status: 400 });

  const result = await attemptLogin(body.login, body.password);
  if (!result.ok) {
    if (result.reason === "disabled") return NextResponse.json({ error: "This page is not switched on" }, { status: 503 });
    if (result.reason === "locked") {
      return NextResponse.json({ error: `Too many wrong tries. Wait ${result.retryInMin} min.` }, { status: 429 });
    }
    return NextResponse.json({ error: "Wrong login or password" }, { status: 401 });
  }

  const { token, expires } = makeToken(result.sid);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(LAB_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    expires,
  });
  return res;
}
