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
    await q`CREATE TABLE IF NOT EXISTS tl_users (id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, password_salt text NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS tl_workspaces (id text PRIMARY KEY, owner_id text UNIQUE NOT NULL REFERENCES tl_users(id), name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS tl_sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES tl_users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS tl_connections (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES tl_workspaces(id) ON DELETE CASCADE, provider text NOT NULL, status text NOT NULL DEFAULT 'pending', external_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id, provider))`;
    await q`ALTER TABLE tl_connections ADD COLUMN IF NOT EXISTS credentials text`;
  })();
  return ready;
}
export function database() { return sql(); }
