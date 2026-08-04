import { neon } from "@neondatabase/serverless";

let ready;
function sql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  return neon(process.env.DATABASE_URL);
}

export async function ensureSchema() {
  if (ready) return ready;
  ready = (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS tl_users (id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, password_salt text NOT NULL, password_hash text NOT NULL, role text NOT NULL DEFAULT 'member', created_at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS tl_workspaces (id text PRIMARY KEY, owner_id text UNIQUE NOT NULL REFERENCES tl_users(id), name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS tl_sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES tl_users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS tl_connections (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES tl_workspaces(id) ON DELETE CASCADE, provider text NOT NULL, status text NOT NULL DEFAULT 'pending', external_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id, provider))`;
    await q`ALTER TABLE tl_connections ADD COLUMN IF NOT EXISTS credentials text`;
    await q`CREATE TABLE IF NOT EXISTS tl_conversations (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES tl_workspaces(id) ON DELETE CASCADE, provider text NOT NULL, external_id text NOT NULL, customer_name text, customer_phone text, last_message_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id, provider, external_id))`;
    await q`CREATE TABLE IF NOT EXISTS tl_messages (id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES tl_conversations(id) ON DELETE CASCADE, external_id text UNIQUE, direction text NOT NULL, body text NOT NULL, sent_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now())`;
    await q`ALTER TABLE tl_users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'`;
    await q`UPDATE tl_users SET role='admin' WHERE email=${(process.env.SUPER_ADMIN_EMAIL || "admin@tickloop.com").trim().toLowerCase()}`;
  })();
  return ready;
}
export function database() { return sql(); }
