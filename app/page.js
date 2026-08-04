"use client";

import { useEffect, useState } from "react";

function BrandMark({ className = "" }) {
  return <img className={`brandMark ${className}`.trim()} src="/tickloop-mark.png" alt="TickLoop" />;
}

export default function Page() {
  const [user, setUser] = useState(undefined);
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [workspace, setWorkspace] = useState(null);
  const [notice, setNotice] = useState("");

  const load = async () => {
    const response = await fetch("/api/auth/me");
    if (!response.ok) return setUser(null);
    const data = await response.json();
    setUser(data.user);
    if (data.user) {
      const details = await fetch("/api/workspace");
      if (details.ok) setWorkspace(await details.json());
    }
  };

  useEffect(() => {
    load();
    const result = new URLSearchParams(window.location.search).get("tiktok");
    if (result) {
      setNotice(result === "connected" ? "TikTok Shop is connected." : "TikTok Shop could not complete connection. Please try again.");
      window.history.replaceState({}, "", "/");
    }
  }, []);

  async function authenticate(event) {
    event.preventDefault(); setLoading(true); setError("");
    const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
    const data = await response.json(); setLoading(false);
    if (!response.ok) return setError(data.error || "Something went wrong.");
    await load();
  }

  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); setUser(null); setWorkspace(null); }

  async function connect(provider) {
    const response = await fetch("/api/integrations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error || "Connection could not start.");
    if (data.authorizationUrl) return window.location.assign(data.authorizationUrl);
    setNotice(data.message); await load();
  }

  if (user === undefined) return <div className="splash">Loading TickLoop…</div>;

  if (!user) return <main className="auth"><section className="authBrand"><BrandMark /><p className="eyebrow">TIKTOK SHOP × WHATSAPP</p><h1>Every order deserves a real conversation.</h1><p className="sub">TickLoop brings TikTok Shop context into your WhatsApp customer inbox.</p></section><section className="authForm"><div className="formBox"><div className="logoInline"><BrandMark className="smallMark" /><b>TickLoop</b></div><h2>{mode === "register" ? "Create your workspace" : "Welcome back"}</h2><p>{mode === "register" ? "Start with your workspace, then connect your channels." : "Sign in to your TickLoop workspace."}</p><form onSubmit={authenticate}>{mode === "register" && <label>Name<input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="Your name" /></label>}<label>Work email<input required type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} placeholder="you@company.com" /></label><label>Password<input required type="password" minLength="8" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} placeholder="At least 8 characters" /></label>{error && <div className="error">{error}</div>}<button className="primary wide" disabled={loading}>{loading ? "Please wait…" : mode === "register" ? "Create workspace" : "Sign in"}</button></form><button className="switch" onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); }}>{mode === "register" ? "Already have an account? Sign in" : "New to TickLoop? Create an account"}</button></div></section></main>;

  const connection = (provider) => workspace?.connections?.find(item => item.provider === provider);
  const tiktok = connection("tiktok_shop");
  const whatsapp = connection("whatsapp");
  const setupReady = Boolean(tiktok?.status === "connected" && whatsapp?.status === "connected");

  return <main className="emptyApp"><aside className="simpleRail"><BrandMark /><div className="railGrow"/><button className="accountButton" onClick={logout} title="Sign out">{user.name?.[0]?.toUpperCase()}</button></aside><header className="mobileHeader"><div><BrandMark className="mobileMark" /><b>TickLoop</b></div><button onClick={logout}>Sign out</button></header><aside className="inboxColumn"><header><h1>Inbox</h1><p>All conversations</p></header><div className="emptyList"><strong>No conversations yet</strong><span>Customer messages will appear here after you connect WhatsApp.</span></div></aside><section className="inboxEmpty"><div className="readyCard"><div className="readyMark">✓</div><p className="eyebrow">YOUR INBOX IS READY</p><h2>Start by connecting your channels.</h2><p>When TikTok Shop orders and WhatsApp messages arrive, they will appear here as real customer conversations.</p><div className="setupLine"><span className={tiktok?.status === "connected" ? "complete" : ""}>{tiktok?.status === "connected" ? "✓" : "1"}</span><b>Connect TikTok Shop</b><small>{tiktok?.status === "connected" ? "Connected" : "Order context"}</small></div><div className="setupLine"><span className={whatsapp?.status === "connected" ? "complete" : ""}>{whatsapp?.status === "connected" ? "✓" : "2"}</span><b>Connect WhatsApp</b><small>{whatsapp?.status === "connected" ? "Connected" : "Customer messages"}</small></div><div className="mobileConnectActions"><button className="mobileConnect" onClick={() => connect("tiktok_shop")}>{tiktok?.status === "connected" ? "TikTok Shop connected" : "Connect TikTok Shop"}</button><button className="mobileConnect secondary" onClick={() => connect("whatsapp")}>{whatsapp?.status === "connected" ? "WhatsApp connected" : whatsapp?.status === "pending" ? "Continue WhatsApp setup" : "Connect WhatsApp"}</button></div></div></section><aside className="setupPanel"><h2>Workspace setup</h2><p className="setupIntro">Connect your channels before your inbox starts receiving customers.</p><section className="connectionCard"><div><b>TikTok Shop</b><p>{tiktok?.status === "connected" ? "Your seller account is connected." : "Add order context to every conversation."}</p></div><button className="connectButton" onClick={() => connect("tiktok_shop")}>{tiktok?.status === "connected" ? "Connected" : "Connect TikTok Shop"}</button></section><section className="connectionCard"><div><b>WhatsApp</b><p>{whatsapp?.status === "connected" ? "Your WhatsApp number is connected." : "Bring new customer messages into TickLoop."}</p></div><button className="connectButton" onClick={() => connect("whatsapp")}>{whatsapp?.status === "connected" ? "Connected" : whatsapp?.status === "pending" ? "Continue WhatsApp setup" : "Connect WhatsApp"}</button></section><div className="workspaceBlock"><small>WORKSPACE</small><b>{workspace?.user?.workspace_name || "Your TickLoop workspace"}</b><span>{user.email}</span></div>{setupReady && <p className="allReady">✓ Both channels are connected.</p>}</aside>{notice && <button className="notice" onClick={() => setNotice("")}>{notice}</button>}</main>;
}
