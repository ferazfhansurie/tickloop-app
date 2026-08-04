"use client";

import { useEffect, useState } from "react";

export default function WhatsAppConnectPage() {
  const [pairing, setPairing] = useState({ loading: true, qrDataUrl: "", status: "pairing", error: "" });
  useEffect(() => {
    let active = true;
    async function refresh() {
      const response = await fetch("/api/whatsapp/pair");
      const payload = await response.json();
      if (active && response.ok) setPairing(current => ({ ...current, loading: false, status: payload.status, qrDataUrl: payload.qrDataUrl || "" }));
    }
    fetch("/api/whatsapp/pair", { method: "POST" }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not prepare WhatsApp linking.");
      refresh();
    }).catch(error => active && setPairing({ loading: false, qrDataUrl: "", status: "pairing", error: error.message }));
    const interval = setInterval(refresh, 2500);
    return () => { active = false; clearInterval(interval); };
  }, []);

  if (pairing.status === "connected") return <main className="pairShell"><section className="pairSuccess"><div className="successBadge">✓</div><p className="eyebrow">WHATSAPP CONNECTED</p><h1>Your inbox is ready.</h1><p>This WhatsApp number is linked to this workspace. New customer messages will arrive in TickLoop.</p><a className="primary pairReturn" href="/">Open inbox</a></section></main>;

  return <main className="pairShell"><section className="pairFlow"><header className="pairHeader"><a href="/" className="backLink">← Back to inbox</a><span className="connectorLive"><i/> Local connector online</span></header><div className="pairIntro"><p className="eyebrow">LINK WHATSAPP</p><h1>Scan to connect.</h1><p>Use WhatsApp on your phone to link this number to your TickLoop workspace.</p></div><div className="pairGrid"><section className="pairSteps"><span className="stepNumber">1</span><div><b>Open WhatsApp on your phone</b><p>Go to Settings or Menu → Linked devices.</p></div><span className="stepNumber">2</span><div><b>Choose “Link a device”</b><p>Use your phone camera to scan this code.</p></div><span className="stepNumber">3</span><div><b>Keep this page open</b><p>TickLoop will confirm as soon as the connection is complete.</p></div></section><section className="qrPanel"><div className="qrLabel"><span className="qrPulse"/> Ready to scan</div>{pairing.qrDataUrl ? <img src={pairing.qrDataUrl} alt="WhatsApp QR code for this TickLoop workspace" /> : <div className="qrWaiting"><span/><b>{pairing.loading ? "Preparing secure QR…" : "Refreshing your QR code…"}</b><small>This usually takes a few seconds.</small></div>}<p>This QR belongs only to this workspace.</p></section></div>{pairing.error && <p className="error">{pairing.error}</p>}<p className="pairPrivacy">Your WhatsApp session stays encrypted on your connected laptop. TickLoop never displays your session data.</p></section></main>;
}
