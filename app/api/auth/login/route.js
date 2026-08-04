import { NextResponse } from "next/server";
import { authenticate, createSession, sessionCookie } from "../../../../lib/auth";
export const runtime = "nodejs";
export async function POST(request) { try { const { email, password } = await request.json(); const user = await authenticate(email || "", password || ""); if (!user) return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 }); const response = NextResponse.json({ user: { name: user.name, email: user.email } }); return sessionCookie(response, await createSession(user.id)); } catch { return NextResponse.json({ error: "Could not sign you in." }, { status: 500 }); } }
