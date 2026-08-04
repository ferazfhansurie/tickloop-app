"use client";

import { useEffect, useState } from "react";

const label = (value) => value === "not_connected" ? "Not connected" : value === "authorizing" ? "Authorizing" : value === "pending" ? "Setup pending" : value === "connected" ? "Connected" : value;

export default function AdminPage() {
  const [state, setState] = useState({ loading: true, error: "", data: null });
  useEffect(() => {
    fetch("/api/admin/overview").then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load admin data.");
      setState({ loading: false, error: "", data: payload });
    }).catch(error => setState({ loading: false, error: error.message, data: null }));
  }, []);

  if (state.loading) return <main className="adminShell"><p>Loading TickLoop admin…</p></main>;
  if (state.error) return <main className="adminShell"><section className="adminError"><h1>Admin access</h1><p>{state.error}</p><a href="/">Return to TickLoop</a></section></main>;
  const { totals, users } = state.data;
  return <main className="adminShell"><header className="adminHeader"><div><p>SUPER ADMIN</p><h1>TickLoop control room</h1></div><a href="/">Open inbox</a></header><section className="adminStats"><article><span>Users</span><b>{totals.users}</b></article><article><span>Workspaces</span><b>{totals.workspaces}</b></article><article><span>TikTok Shop connected</span><b>{totals.tiktok_connected}</b></article><article><span>WhatsApp connected</span><b>{totals.whatsapp_connected}</b></article></section><section className="adminTable"><div className="adminTableTitle"><div><h2>Users & connections</h2><p>Connection statuses only. Credentials are never shown here.</p></div><span>{users.length} total</span></div><div className="tableWrap"><table><thead><tr><th>User</th><th>Workspace</th><th>Role</th><th>TikTok Shop</th><th>WhatsApp</th><th>Joined</th></tr></thead><tbody>{users.map(item => <tr key={item.id}><td><strong>{item.name}</strong><small>{item.email}</small></td><td>{item.workspace_name || "—"}</td><td><span className={`role ${item.role}`}>{item.role}</span></td><td><span className={`connectionStatus ${item.tiktok_status}`}>{label(item.tiktok_status)}</span></td><td><span className={`connectionStatus ${item.whatsapp_status}`}>{label(item.whatsapp_status)}</span></td><td>{new Date(item.created_at).toLocaleDateString()}</td></tr>)}</tbody></table></div></section></main>;
}
