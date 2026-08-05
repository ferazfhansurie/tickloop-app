"use client";

import { useEffect, useRef, useState } from "react";

function dayLabel(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
}

// WhatsApp groups a thread under day headings; mirror that so long histories stay readable.
function groupByDay(messages) {
  const groups = [];
  for (const message of messages) {
    const label = dayLabel(message.sent_at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(message);
    else groups.push({ label, items: [message] });
  }
  return groups;
}

function clockTime(value) {
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fileSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

// One attachment inside a bubble. Images/video/audio play inline; anything else
// (and any attachment whose bytes we could not capture) falls back to a file card.
function Attachment({ message }) {
  const src = message.media_id ? `/api/media/${message.media_id}` : null;
  const kind = message.media_kind;
  if (src && (kind === "image" || kind === "sticker")) {
    return <a href={src} target="_blank" rel="noreferrer" className="mediaImageLink"><img className="mediaImage" src={src} alt={message.media_name || "Photo"} /></a>;
  }
  if (src && kind === "video") return <video className="mediaVideo" src={src} controls preload="metadata" />;
  if (src && kind === "audio") return <audio className="mediaAudio" src={src} controls preload="metadata" />;
  return (
    <a className={`mediaFile${src ? "" : " pending"}`} href={src || undefined} target="_blank" rel="noreferrer" download={message.media_name || undefined}>
      <span className="mediaIcon">{kind === "video" ? "▶" : kind === "audio" ? "♪" : "📄"}</span>
      <span className="mediaMeta">
        <b>{message.media_name || (kind ? `${kind} attachment` : "Attachment")}</b>
        <small>{src ? fileSize(message.media_size) || "Download" : "Not synced"}</small>
      </span>
    </a>
  );
}

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
  const [thread, setThread] = useState({ messages: [], total: 0, limit: 0, limited: false, loading: false });
  const threadScrollRef = useRef(null);
  const stickToBottom = useRef(true);
  // The list auto-selects the first conversation, so the thread has to follow the
  // same fallback — and it must be computed before the early returns below.
  const effectiveConversationId = activeConversation || conversations[0]?.id || null;

  async function loadConversations() {
    const response = await fetch("/api/conversations");
    if (response.ok) setConversations((await response.json()).conversations || []);
  }

  const [draft, setDraft] = useState("");
  const [pendingFile, setPendingFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [forwarding, setForwarding] = useState(null); // message being forwarded
  const fileInputRef = useRef(null);

  // Queue a reply (text and/or one attachment) on the open conversation.
  async function sendMessage(event) {
    event?.preventDefault();
    if (sending) return;
    const text = draft.trim();
    if (!text && !pendingFile) return;
    setSending(true);
    try {
      const media = pendingFile
        ? { base64: await fileToBase64(pendingFile), mime: pendingFile.type || "application/octet-stream", name: pendingFile.name }
        : null;
      const response = await fetch("/api/messages/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: effectiveConversationId, body: text, media }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setNotice(data.error || "Could not send."); return; }
      setDraft(""); setPendingFile(null);
      stickToBottom.current = true;
      // The adapter sends it and reports back; poll a little sooner than the timer.
      window.setTimeout(() => loadThread(effectiveConversationId, { quiet: true }), 1200);
    } catch (error) {
      setNotice(error.message || "Could not send.");
    } finally { setSending(false); }
  }

  // Forward an existing message (with its attachment, if we captured one) to
  // another conversation, without re-uploading anything.
  async function forwardTo(conversationId) {
    if (!forwarding) return;
    setSending(true);
    try {
      const response = await fetch("/api/messages/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, body: forwarding.body || "", mediaId: forwarding.media_id || null }),
      });
      const data = await response.json().catch(() => ({}));
      setNotice(response.ok ? "Forwarded." : (data.error || "Could not forward."));
    } finally { setSending(false); setForwarding(null); }
  }

  async function loadThread(conversationId, { quiet = false } = {}) {
    if (!conversationId) return setThread({ messages: [], total: 0, limit: 0, limited: false, loading: false });
    if (!quiet) setThread(current => ({ ...current, loading: true }));
    const response = await fetch(`/api/messages?conversationId=${encodeURIComponent(conversationId)}`);
    if (!response.ok) return setThread(current => ({ ...current, loading: false }));
    const data = await response.json();
    setThread({ messages: data.messages || [], total: data.total || 0, limit: data.limit || 0, limited: !!data.limited, loading: false });
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

  // Open thread: fetch once, then poll quietly so new messages land like WhatsApp.
  useEffect(() => {
    if (!user || !effectiveConversationId) return undefined;
    stickToBottom.current = true;
    loadThread(effectiveConversationId);
    const interval = window.setInterval(() => loadThread(effectiveConversationId, { quiet: true }), 4000);
    return () => window.clearInterval(interval);
  }, [user, effectiveConversationId]);

  // Stay pinned to the newest message unless the user has scrolled up to read back.
  useEffect(() => {
    const node = threadScrollRef.current;
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [thread.messages]);

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
  const active = conversations.find(item => item.id === effectiveConversationId) || conversations[0];
  const sync = whatsapp?.metadata || {};

  return <main className="emptyApp">
    <aside className="simpleRail"><BrandMark /><div className="railGrow"/><button className="accountButton" onClick={logout} title="Sign out">{user.name?.[0]?.toUpperCase()}</button></aside>
    <header className="mobileHeader"><div><BrandMark className="mobileMark" /><b>TickLoop</b></div><button onClick={logout}>Sign out</button></header>
    <aside className="inboxColumn"><header><h1>Inbox</h1><p>{conversations.length ? `${conversations.length} conversation${conversations.length === 1 ? "" : "s"}` : "All conversations"}</p></header><div className="conversationList">{conversations.length ? conversations.map(item => <button key={item.id} className={`conversationItem ${active?.id === item.id ? "selected" : ""}`} onClick={() => setActiveConversation(item.id)}><ConversationAvatar conversation={item} /><span><b>{item.customer_name || "Customer"}</b><small>{item.provider === "whatsapp" ? "WhatsApp" : "TikTok Shop"} · {item.last_message || "New order"}</small></span></button>) : <div className="emptyList"><strong>No conversations yet</strong><span>New WhatsApp messages and TikTok order events appear here automatically.</span></div>}</div></aside>
    <section className={`inboxEmpty${active ? " hasThread" : ""}`}>{active ? <div className="thread"><header className="threadHeader"><ConversationAvatar conversation={active} /><div className="threadWho"><b>{active.customer_name || "Customer"}</b><small>{active.customer_phone || "Contact protected"}</small></div><span className="threadChannel">{active.provider === "whatsapp" ? "WhatsApp" : "TikTok Shop"}</span></header><div className="threadScroll" ref={threadScrollRef} onScroll={event => { const el = event.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>{thread.limited && <p className="syncLimit"><b>Sync limit reached</b><span>Showing the latest {thread.limit} of {thread.total} messages. WhatsApp does not expose older history.</span></p>}{thread.loading && !thread.messages.length ? <p className="threadHint">Loading messages…</p> : null}{!thread.loading && !thread.messages.length ? <p className="threadHint">No messages synced for this conversation yet.</p> : null}{groupByDay(thread.messages).map(group => <div className="dayGroup" key={`${group.label}-${group.items[0].id}`}><div className="dayDivider"><span>{group.label}</span></div>{group.items.map(message => <div key={message.id} className={`bubbleRow ${message.direction === "outbound" ? "out" : "in"}`}><div className={`bubble ${message.direction === "outbound" ? "out" : "in"}${message.media_kind ? " hasMedia" : ""}`}>{message.media_kind && <Attachment message={message} />}{message.body ? <span className="bubbleText">{message.body}</span> : null}<time>{clockTime(message.sent_at)}</time></div><button type="button" className="forwardBtn" title="Forward" onClick={() => setForwarding(message)}>↪</button></div>)}</div>)}</div><form className="composer" onSubmit={sendMessage}>{pendingFile && <div className="pendingFile"><span>📎 {pendingFile.name} <small>{fileSize(pendingFile.size)}</small></span><button type="button" onClick={() => setPendingFile(null)}>✕</button></div>}<div className="composerRow"><button type="button" className="attachBtn" title="Attach" onClick={() => fileInputRef.current?.click()}>＋</button><input ref={fileInputRef} type="file" hidden accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip" onChange={event => { const file = event.target.files?.[0]; if (file) setPendingFile(file); event.target.value = ""; }} /><textarea className="composerInput" rows={1} placeholder="Type a message" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} /><button className="sendBtn" disabled={sending || (!draft.trim() && !pendingFile)} title="Send">{sending ? "…" : "➤"}</button></div></form></div> :<div className="readyCard"><div className="readyMark">✓</div><p className="eyebrow">YOUR INBOX IS READY</p><h2>Start by connecting your channels.</h2><p>When TikTok Shop orders and WhatsApp messages arrive, they will appear here as real customer conversations.</p><div className="setupLine"><span className={tiktok?.status === "connected" ? "complete" : ""}>{tiktok?.status === "connected" ? "✓" : "1"}</span><b>Connect TikTok Shop</b><small>{tiktok?.status === "connected" ? "Connected" : "Order context"}</small></div><div className="setupLine"><span className={whatsapp?.status === "connected" ? "complete" : ""}>{whatsapp?.status === "connected" ? "✓" : "2"}</span><b>Connect WhatsApp</b><small>{whatsapp?.status === "connected" ? "Connected" : "Customer messages"}</small></div><button className="testOrderButton" onClick={createTestOrder} disabled={creatingTestOrder}>{creatingTestOrder ? "Creating test order…" : "Create a test TikTok order"}</button><p className="testNote">Tests stay inside TickLoop. No WhatsApp message is sent.</p></div>}</section>
    <aside className="setupPanel"><h2>Workspace setup</h2><p className="setupIntro">Connect your channels before your inbox starts receiving customers.</p><section className="connectionCard"><div><b>TikTok Shop</b><p>{tiktok?.status === "connected" ? "Your seller account is connected." : "Add order context to every conversation."}</p></div><button className="connectButton" onClick={() => connect("tiktok_shop")}>{tiktok?.status === "connected" ? "Connected" : "Connect TikTok Shop"}</button></section><section className="connectionCard"><div><b>WhatsApp</b><p>{whatsapp?.status === "connected" ? "Your WhatsApp number is connected." : "Bring new customer messages into TickLoop."}</p></div><button className="connectButton" onClick={() => connect("whatsapp")}>{whatsapp?.status === "connected" ? "Connected" : "Connect WhatsApp"}</button></section><section className="connectionCard automationCard"><div><b>Post-purchase testing</b><p>Create a dummy paid order and confirm that order context reaches the inbox.</p></div><button className="connectButton" onClick={createTestOrder} disabled={creatingTestOrder}>{creatingTestOrder ? "Creating…" : "Create test order"}</button></section><section className="connectionCard testSendCard"><b>Send a direct test</b><p>Use a number you control or have permission to message.</p><form onSubmit={sendTestMessage}><input required value={testSend.phone} onChange={event => setTestSend({ ...testSend, phone: event.target.value })} placeholder="+60 12 345 6789" /><textarea required value={testSend.message} onChange={event => setTestSend({ ...testSend, message: event.target.value })} /><label className="consentCheck"><input type="checkbox" checked={testSend.confirmed} onChange={event => setTestSend({ ...testSend, confirmed: event.target.checked })} /> I have permission to message this number.</label><button className="connectButton" disabled={sendingTest}>{sendingTest ? "Sending…" : "Send test message"}</button></form></section><div className="workspaceBlock"><small>WORKSPACE</small><b>{workspace?.user?.workspace_name || "Your TickLoop workspace"}</b><span>{user.email}</span>{user.role === "admin" && <a className="adminLink" href="/admin">Open admin dashboard</a>}</div>{setupReady && <p className="allReady">✓ Both channels are connected.</p>}</aside>
    {whatsapp?.status === "connected" && <div className={`syncStatus ${sync.syncStatus || "waiting"}`}><span>{sync.syncStatus === "complete" ? "✓" : "↻"}</span><div><b>{sync.syncStatus === "complete" ? "WhatsApp history synced" : sync.syncStatus === "retrying" ? "Retrying WhatsApp history" : sync.syncStatus === "syncing" ? "Syncing WhatsApp history" : "Live WhatsApp sync active"}</b><small>{sync.syncTotal ? `${sync.syncImported || 0} of ${sync.syncTotal} messages imported` : sync.lastSyncError || "New messages appear here automatically."}</small></div></div>}
    {forwarding && <div className="forwardOverlay" onClick={() => setForwarding(null)}><div className="forwardCard" onClick={event => event.stopPropagation()}><header><b>Forward to…</b><button type="button" onClick={() => setForwarding(null)}>✕</button></header><p className="forwardPreview">{forwarding.media_kind ? `📎 ${forwarding.media_name || forwarding.media_kind} ` : ""}{forwarding.body?.slice(0, 120) || ""}</p><div className="forwardList">{conversations.filter(item => item.id !== effectiveConversationId && item.provider === "whatsapp").map(item => <button key={item.id} type="button" disabled={sending} onClick={() => forwardTo(item.id)}><ConversationAvatar conversation={item} /><span>{item.customer_name || item.customer_phone || "Customer"}</span></button>)}</div></div></div>}
    {notice && <button className="notice" onClick={() => setNotice("")}>{notice}</button>}
  </main>;
}
