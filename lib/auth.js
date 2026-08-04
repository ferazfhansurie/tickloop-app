import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { database, ensureSchema } from "./db";
const derive = promisify(pbkdf2);
const iterations = 310000;
const tokenHash = (value) => createHash("sha256").update(value).digest("hex");
const id = (prefix) => `${prefix}_${randomBytes(16).toString("hex")}`;
export const COOKIE = "tickloop_session";

async function passwordHash(password, salt) { return (await derive(password, Buffer.from(salt, "hex"), iterations, 32, "sha256")).toString("hex"); }
export async function registerUser({ name, email, password }) {
  await ensureSchema(); const q = database(); const normalized = email.trim().toLowerCase(); const displayName = name.trim(); const workspaceName = `${displayName} workspace`; const salt = randomBytes(16).toString("hex"); const hash = await passwordHash(password, salt); const userId = id("usr"); const workspaceId = id("ws");
  try { await q`INSERT INTO tl_users (id,email,name,password_salt,password_hash) VALUES (${userId},${normalized},${displayName},${salt},${hash})`; await q`INSERT INTO tl_workspaces (id,owner_id,name) VALUES (${workspaceId},${userId},${workspaceName})`; }
  catch (error) { if (error?.code === "23505") { const conflict = new Error("An account with this email already exists."); conflict.status = 409; throw conflict; } throw error; }
  return { id: userId, name: displayName, email: normalized, workspaceId };
}
export async function authenticate(email, password) { await ensureSchema(); const q = database(); const rows = await q`SELECT id,name,email,password_salt,password_hash FROM tl_users WHERE email=${email.trim().toLowerCase()} LIMIT 1`; const user = rows[0]; if (!user) return null; const hash = await passwordHash(password, user.password_salt); if (!timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.password_hash, "hex"))) return null; return user; }
export async function createSession(userId) { await ensureSchema(); const q = database(); const token = randomBytes(32).toString("base64url"); await q`INSERT INTO tl_sessions (token_hash,user_id,expires_at) VALUES (${tokenHash(token)},${userId},now() + interval '30 days')`; return token; }
export async function currentUser(request) { const token = request.cookies.get(COOKIE)?.value; if (!token) return null; await ensureSchema(); const q = database(); const rows = await q`SELECT u.id,u.name,u.email,w.id AS workspace_id,w.name AS workspace_name FROM tl_sessions s JOIN tl_users u ON u.id=s.user_id JOIN tl_workspaces w ON w.owner_id=u.id WHERE s.token_hash=${tokenHash(token)} AND s.expires_at > now() LIMIT 1`; return rows[0] || null; }
export async function deleteSession(request) { const token = request.cookies.get(COOKIE)?.value; if (token) { await ensureSchema(); await database()`DELETE FROM tl_sessions WHERE token_hash=${tokenHash(token)}`; } }
export function sessionCookie(response, token) { response.cookies.set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 }); return response; }
