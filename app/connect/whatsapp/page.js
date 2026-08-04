"use client";

import { useEffect, useState } from "react";

export default function WhatsAppConnectPage() {
  const [pairing, setPairing] = useState({ loading: true, token: "", appUrl: "", qrDataUrl: "", status: "pairing", error: "" });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    async function refresh() {
      const response = await fetch("/api/whatsapp/pair");
      const payload = await response.json();
      if (active && response.ok) setPairing(current => ({ ...current, loading: false, status: payload.status, qrDataUrl: payload.qrDataUrl || "", token: payload.token || current.token }));
    }
    fetch("/api/whatsapp/pair", { method: "POST" }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not start pairing.");
      if (active) setPairing({ loading: false, token: payload.token, appUrl: payload.appUrl, qrDataUrl: "", status: "pairing", error: "" });
      refresh();
    }).catch(error => active && setPairing({ loading: false, token: "", appUrl: "", qrDataUrl: "", status: "pairing", error: error.message }));
    const interval = setInterval(refresh, 2500);
    return () => { active = false; clearInterval(interval); };
  }, []);
  const command = pairing.token ? `cd whatsapp-worker && PUPPETEER_SKIP_DOWNLOAD=true npm install && TICKLOOP_URL=${pairing.appUrl} TICKLOOP_WORKER_TOKEN=${pairing.token} npm start` : "";
  async function copy() { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1800); }
  return <main className="pairShell"><section className="pairCard"><a href="/" className="backLink">← Back to inbox</a><p className="eyebrow">LOCAL WHATSAPP WORKER</p><h1>{pairing.status === "connected" ? "WhatsApp is connected." : "Connect from your laptop."}</h1><p>TickLoop keeps the WhatsApp browser session on your laptop, but your private QR code appears below in this workspace only.</p>{pairing.loading && <p className="pairStatus">Creating a secure pairing token…</p>}{pairing.error && <p className="error">{pairing.error}</p>}{pairing.status === "connected" && <><p className="connectedNotice">✓ Your WhatsApp worker is online.</p><a className="primary wide pairReturn" href="/">Go to inbox</a></>}{pairing.token && pairing.status !== "connected" && <><ol><li>Open Terminal in the TickLoop project folder.</li><li>Run this command once. The token expires in 15 minutes.</li><li>Scan the QR code shown on this page from WhatsApp → Linked devices.</li></ol><pre>{command}</pre><button className="primary wide" onClick={copy}>{copied ? "Copied" : "Copy setup command"}</button>{pairing.qrDataUrl ? <div className="workspaceQr"><img src={pairing.qrDataUrl} alt="WhatsApp pairing QR code" /><b>Scan this QR code from WhatsApp.</b></div> : <p className="pairStatus">Waiting for your local worker to start. The QR will appear here automatically.</p>}<p className="pairNote">Keep the worker terminal open. Its WhatsApp session is stored only on this laptop.</p></>}</section></main>;
}
