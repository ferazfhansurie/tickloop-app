"use client";

import { useEffect, useState } from "react";

function BrandMark({ className = "" }) {
  return <img className={`brandMark ${className}`.trim()} src="/tickloop-mark.png" alt="TickLoop" />;
}

function ConversationAvatar({ conversation }) {
  return <span className="conversationAvatar">{conversation.avatar_url ? <img src={conversation.avatar_url} alt="" /> : (conversation.customer_name || "C")[0].toUpperCase()}</span>;
}

export default function Page() {
  const [user, setUser] = useState(undefined);
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [workspace, setWorkspace] = useState(null);
  const [notice, setNotice] = useState("");
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [creatingTestOrder, setCreatingTestOrder] = useState(false);
  const [testSend, setTestSend] = useState({ phone: "", message: "Hello! This is a TickLoop test message.", confirmed: false });
  const [sendingTest, setSendingTest] = useState(false);

  async function loadConversations() {
    const response = await fetch("/api/conversations");
    if (response.ok) setConversations((await response.json()).conversations || []);
  }

  async function load() {
    const response = await fetch("/api/auth/me");
    if (!response.ok) return setUser(null);
    const data = await response.json(); setUser(data.user);
    if (data.user) {
      const details = await fetch("/api/workspace");
      if (details.ok) setWorkspace(await details.json());
      await loadConversations();
    }
  }

  useEffect(() => {
    load();
    const result = new URLSearchParams(window.location.search).get("tiktok");
    if (result) {
      setNotice(result === "connected" ? "TikTok Shop is connected." : "TikTok Shop could not complete connection. Please try again.");
      window.history.replaceState({}, "", "/");
    }
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const interval = window.setInterval(loadConversations, 4000);
    return () => window.clearInterval(interval);
  }, [user]);

  async function authenticate(event) {
    event.preventDefault(); setLoading(true); setError("");
    const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
    const data = await response.json(); setLoading(false);
    if (!response.ok) return setError(data.error || "Something went wrong.");
    await load();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null); setWorkspace(null); setConversations([]);
  }

  async function connect(provider) {
    const response = await fetch("/api/integrations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error || "Connection could not start.");
    if (data.authorizationUrl) return window.location.assign(data.authorizationUrl);
    if (data.pairingUrl) return window.location.assign(data.pairingUrl);
    setNotice(data.message); await load();
  }

  async function createTestOrder() {
    setCreatingTestOrder(true);
    const response = await fetch("/api/automations/test-order", { method: "POST" });
    const data = await response.json(); setCreatingTestOrder(false);
    if (!response.ok) return setNotice(data.error || "The test order could not be created.");
    setNotice(`${data.orderId} created. It is an inbox-only test; nothing was sent to WhatsApp.`);
    await loadConversations(); setActiveConversation(data.conversationId);
  }

  async function sendTestMessage(event) {
    event.preventDefault(); setSendingTest(true);
    const response = await fetch("/api/whatsapp/test-send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(testSend) });
    const data = await response.json(); setSendingTest(false);
    if (!response.ok) return setNotice(data.error || "Test message could not be queued.");
    setNotice("Test message queued. It will send from your connected WhatsApp in a few seconds.");
  }

  if (user === undefined) return <div className="splash">Loading TickLoop…</div>;
  if (!user) return <main className="auth"><section className="authBrand"><BrandMark /><p className="eyebrow">TIKTOK SHOP × WHATSAPP</p><h1>Every order deserves a real conversation.</h1><p className="sub">TickLoop brings TikTok Shop context into your WhatsApp customer inbox.</p></section><section className="authForm"><div className="formBox"><div className="logoInline"><BrandMark className="smallMark" /><b>TickLoop</b></div><h2>{mode === "register" ? "Create your workspace" : "Welcome back"}</h2><p>{mode === "register" ? "Start with your workspace, then connect your channels." : "Sign in to your TickLoop workspace."}</p><form onSubmit={authenticate}>{mode === "register" && <label>Name<input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="Your name" /></label>}<label>Work email<input required type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} placeholder="you@company.com" /></label><label>Password<input required type="password" minLength="8" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} placeholder="At least 8 characters" /></label>{error && <div className="error">{error}</div>}<button className="primary wide" disabled={loading}>{loading ? "Please wait…" : mode === "register" ? "Create workspace" : "Sign in"}</button></form><button className="switch" onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); }}>{mode === "register" ? "Already have an account? Sign in" : "New to TickLoop? Create an account"}</button></div></section></main>;

  const connection = provider => workspace?.connections?.find(item => item.provider === provider);
  const tiktok = connection("tiktok_shop"); const whatsapp = connection("whatsapp");
  const setupReady = tiktok?.status === "connected" && whatsapp?.status === "connected";
  const active = conversations.find(item => item.id === activeConversation) || conversations[0];

  return <main className="emptyApp">
    <aside className="simpleRail"><BrandMark /><div className="railGrow"/><button className="accountButton" onClick={logout} title="Sign out">{user.name?.[0]?.toUpperCase()}</button></aside>
    <header className="mobileHeader"><div><BrandMark className="mobileMark" /><b>TickLoop</b></div><button onClick={logout}>Sign out</button></header>
    <aside className="inboxColumn"><header><h1>Inbox</h1><p>{conversations.length ? `${conversations.length} conversation${conversations.length === 1 ? "" : "s"}` : "All conversations"}</p></header><div className="conversationList">{conversations.length ? conversations.map(item => <button key={item.id} className={`conversationItem ${active?.id === item.id ? "selected" : ""}`} onClick={() => setActiveConversation(item.id)}><ConversationAvatar conversation={item} /><span><b>{item.customer_name || "Customer"}</b><small>{item.provider === "whatsapp" ? "WhatsApp" : "TikTok Shop"} · {item.last_message || "New order"}</small></span></button>) : <div className="emptyList"><strong>No conversations yet</strong><span>New WhatsApp messages and TikTok order events appear here automatically.</span></div>}</div></aside>
    <section className="inboxEmpty">{active ? <div className="conversationPreview"><p className="eyebrow">{active.provider === "whatsapp" ? "WHATSAPP MESSAGE" : "TIKTOK SHOP ORDER"}</p><div className="previewIdentity"><ConversationAvatar conversation={active} /><div><h2>{active.customer_name || "Customer"}</h2><p className="conversationPhone">{active.customer_phone || "Customer contact protected"}</p></div></div><div className="messageBubble">{active.last_message || "A new customer event arrived."}</div><p className="syncHint">New inbound WhatsApp messages sync here automatically, usually within a few seconds.</p></div> : <div className="readyCard"><div className="readyMark">✓</div><p className="eyebrow">YOUR INBOX IS READY</p><h2>Start by connecting your channels.</h2><p>When TikTok Shop orders and WhatsApp messages arrive, they will appear here as real customer conversations.</p><div className="setupLine"><span className={tiktok?.status === "connected" ? "complete" : ""}>{tiktok?.status === "connected" ? "✓" : "1"}</span><b>Connect TikTok Shop</b><small>{tiktok?.status === "connected" ? "Connected" : "Order context"}</small></div><div className="setupLine"><span className={whatsapp?.status === "connected" ? "complete" : ""}>{whatsapp?.status === "connected" ? "✓" : "2"}</span><b>Connect WhatsApp</b><small>{whatsapp?.status === "connected" ? "Connected" : "Customer messages"}</small></div><button className="testOrderButton" onClick={createTestOrder} disabled={creatingTestOrder}>{creatingTestOrder ? "Creating test order…" : "Create a test TikTok order"}</button><p className="testNote">Tests stay inside TickLoop. No WhatsApp message is sent.</p></div>}</section>
    <aside className="setupPanel"><h2>Workspace setup</h2><p className="setupIntro">Connect your channels before your inbox starts receiving customers.</p><section className="connectionCard"><div><b>TikTok Shop</b><p>{tiktok?.status === "connected" ? "Your seller account is connected." : "Add order context to every conversation."}</p></div><button className="connectButton" onClick={() => connect("tiktok_shop")}>{tiktok?.status === "connected" ? "Connected" : "Connect TikTok Shop"}</button></section><section className="connectionCard"><div><b>WhatsApp</b><p>{whatsapp?.status === "connected" ? "Your WhatsApp number is connected." : "Bring new customer messages into TickLoop."}</p></div><button className="connectButton" onClick={() => connect("whatsapp")}>{whatsapp?.status === "connected" ? "Connected" : "Connect WhatsApp"}</button></section><section className="connectionCard automationCard"><div><b>Post-purchase testing</b><p>Create a dummy paid order and confirm that order context reaches the inbox.</p></div><button className="connectButton" onClick={createTestOrder} disabled={creatingTestOrder}>{creatingTestOrder ? "Creating…" : "Create test order"}</button></section><section className="connectionCard testSendCard"><b>Send a direct test</b><p>Use a number you control or have permission to message.</p><form onSubmit={sendTestMessage}><input required value={testSend.phone} onChange={event => setTestSend({ ...testSend, phone: event.target.value })} placeholder="+60 12 345 6789" /><textarea required value={testSend.message} onChange={event => setTestSend({ ...testSend, message: event.target.value })} /><label className="consentCheck"><input type="checkbox" checked={testSend.confirmed} onChange={event => setTestSend({ ...testSend, confirmed: event.target.checked })} /> I have permission to message this number.</label><button className="connectButton" disabled={sendingTest}>{sendingTest ? "Sending…" : "Send test message"}</button></form></section><div className="workspaceBlock"><small>WORKSPACE</small><b>{workspace?.user?.workspace_name || "Your TickLoop workspace"}</b><span>{user.email}</span>{user.role === "admin" && <a className="adminLink" href="/admin">Open admin dashboard</a>}</div>{setupReady && <p className="allReady">✓ Both channels are connected.</p>}</aside>
    {notice && <button className="notice" onClick={() => setNotice("")}>{notice}</button>}
  </main>;
}
