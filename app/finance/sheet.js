"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "../theme";

/**
 * Rendered as an actual spreadsheet — lettered columns, numbered rows, a uniform
 * cell grid — because that is the form the seller already reconciles in. Every
 * block (P&L, bundles, settlement breakdown, cost entry) lives on one continuous
 * sheet the way it would in Excel, rather than as separate web cards.
 *
 * Values come from TikTok Shop's own finance model wherever TikTok exposes them.
 */

const COLUMNS = ["A", "B", "C", "D", "E", "F", "G"];
const GROUP_LABELS = { revenue: "Revenue", fee: "Fees & commissions", tax: "Tax", shipping: "Shipping", adjustment: "Adjustments" };
const GROUP_ORDER = ["revenue", "fee", "tax", "shipping", "adjustment"];
const SOURCE_LABEL = { tiktok: "TikTok", manual: "Manual", calc: "Calc" };

function monthValue(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthOptions() {
  const options = [];
  const cursor = new Date();
  for (let index = 0; index < 14; index += 1) {
    const value = monthValue(cursor);
    options.push({ value, label: new Date(`${value}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }) });
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return options;
}
function monthRange(period) {
  const [year, month] = period.split("-").map(Number);
  return { from: new Date(Date.UTC(year, month - 1, 1)).toISOString(), to: new Date(Date.UTC(year, month, 1)).toISOString() };
}

/** Quick ranges. `month` defers to the month picker; the rest are rolling windows. */
const RANGES = [
  { key: "today", label: "today", days: 1 },
  { key: "7d", label: "7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
  { key: "month", label: "month" },
  { key: "all", label: "all", days: 365 },
];

function rangeFor(rangeKey, period) {
  if (rangeKey === "month") return monthRange(period);
  const days = RANGES.find((entry) => entry.key === rangeKey)?.days ?? 30;
  const now = new Date();
  // Whole days in UTC so a range never lands mid-day and splits an order's date.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const start = new Date(end.getTime() - days * 86400000);
  return { from: start.toISOString(), to: end.toISOString() };
}

function rangeLabel(rangeKey, period) {
  if (rangeKey === "month") return new Date(`${period}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  return { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days", all: "Last 12 months" }[rangeKey] || rangeKey;
}

/** "synced 4m ago" — tick is unused but forces a re-render so the label ages. */
function freshness(lastSynced) {
  if (!lastSynced) return "Never synced";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(lastSynced).getTime()) / 1000));
  if (seconds < 60) return "Synced just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${Math.round(hours / 24)}d ago`;
}

/* ------------------------------------------------------------ cell helpers */

const cell = (value, options = {}) => ({ value, ...options });
const blank = () => cell("");
/** A section heading that spans the sheet, like a merged cell. */
const title = (text) => [cell(text, { className: "xlTitle", span: COLUMNS.length })];
const spacer = () => [];

export function FinanceSheet({ compact = false }) {
  const months = useMemo(monthOptions, []);
  const [period, setPeriod] = useState(months[0].value);
  const [rangeKey, setRangeKey] = useState("month");
  const [basis, setBasis] = useState("order");
  // Applies the stored theme so the standalone /finance page matches the app.
  useTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [showCosts, setShowCosts] = useState(false);
  const [live, setLive] = useState(true);
  const [tick, setTick] = useState(0);

  // Cost-entry state lives here so its cells can sit inside the same sheet.
  const [products, setProducts] = useState([]);
  const [periodCost, setPeriodCost] = useState({ period, adsCard: 0, adCredit: 0, whtRate: 0.1, otherCost: 0, adsGmvPayOverride: null, notes: null });
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [opexRows, setOpexRows] = useState([]);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");

  async function syncAffiliates() {
    setImporting(true);
    setImportMessage("");
    try {
      const response = await fetch("/api/finance/affiliates/sync?days=90", { method: "POST" });
      const payload = await response.json();
      if (!response.ok || payload.error) { setImportMessage(payload.error || "Sync failed."); return; }
      setImportMessage(`${payload.imported} orders from ${payload.creators} creators, straight from TikTok.`);
      onSaved();
    } catch (error) {
      setImportMessage(error.message || "Sync failed.");
    } finally {
      setImporting(false);
    }
  }

  async function importAffiliates(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    setImportMessage("");
    try {
      const response = await fetch("/api/finance/affiliates", { method: "POST", body: await file.text() });
      const payload = await response.json();
      if (!response.ok) { setImportMessage(payload.error || "Import failed."); return; }
      setImportMessage(
        payload.imported + " orders from " + payload.creators + " creators, " + payload.matchedOrders + " matched"
        + (payload.unmatchedOrders ? ", " + payload.unmatchedOrders + " not in the synced window" : ""),
      );
      onSaved();
    } catch (error) {
      setImportMessage(error.message || "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  const money = useCallback(
    (value) => {
      const currency = data?.currency || "MYR";
      const amount = Number(value) || 0;
      const formatted = Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return `${amount < 0 ? "-" : ""}${currency === "MYR" ? "RM" : `${currency} `}${formatted}`;
    },
    [data?.currency],
  );

  const load = useCallback(
    async (sync) => {
      const { from, to } = rangeFor(rangeKey, period);
      if (sync) setSyncing(true); else setLoading(true);
      setError("");
      try {
        const query = new URLSearchParams({ from, to, basis });
        if (sync) query.set("sync", "1");
        const response = await fetch(`/api/finance/summary?${query}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) {
          setError(payload.error || "Could not load the dashboard.");
          if (!sync) setData(null);
          return;
        }
        setData(payload);
      } catch (caught) {
        setError(caught.message || "Could not reach the server.");
      } finally {
        setSyncing(false);
        setLoading(false);
      }
    },
    [rangeKey, period, basis],
  );

  useEffect(() => { load(false); }, [load]);

  // Live mode re-reads stored data every 30s. The webhook and the hourly cron do
  // the actual fetching from TikTok, so this stays cheap — no API quota is spent
  // by leaving the page open.
  //
  // Paused while Cost setup is open: a refresh re-seeds the cost rows from the
  // server, which would discard half-typed unit costs mid-edit.
  useEffect(() => {
    if (!live || showCosts) return undefined;
    const id = setInterval(() => load(false), 30000);
    return () => clearInterval(id);
  }, [live, showCosts, load]);

  // Re-renders the "synced Nm ago" label without refetching.
  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 20000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!data) return;
    const existing = new Map((data.productCosts || []).map((cost) => [cost.skuKey, cost]));
    const rows = (data.skus || []).map((sku, index) => {
      const found = existing.get(sku.skuKey);
      return {
        skuKey: sku.skuKey,
        label: sku.skuName || sku.productName || sku.skuKey,
        bundle: found?.bundle || sku.skuName || sku.productName || sku.skuKey,
        unitCost: found?.unitCost ?? 0,
        bottles: found?.bottles ?? 0,
        sortOrder: found?.sortOrder ?? index,
        quantity: sku.quantity,
      };
    });
    for (const cost of data.productCosts || []) {
      if (!rows.some((row) => row.skuKey === cost.skuKey)) rows.push({ ...cost, label: cost.bundle, quantity: 0 });
    }
    setProducts(rows);
    const found = (data.periodCosts || []).find((cost) => cost.period === period);
    setPeriodCost(found || { period, adsCard: 0, adCredit: 0, whtRate: 0.1, otherCost: 0, adsGmvPayOverride: null, fulfilmentRate: 0, cogsMarkupPct: 0, notes: null });

    // Seed from the template so the seller edits a familiar list rather than an
    // empty one, keeping whatever is already saved for this month.
    const saved = new Map((data.opexRows || []).map((row) => [`${row.category}|${row.label}`, Number(row.amount)]));
    const seeded = [];
    for (const [category, labels] of Object.entries(data.opexTemplate || {})) {
      for (const label of labels) seeded.push({ category, label, amount: saved.get(`${category}|${label}`) ?? 0 });
    }
    for (const row of data.opexRows || []) {
      if (!seeded.some((entry) => entry.category === row.category && entry.label === row.label)) seeded.push({ ...row });
    }
    setOpexRows(seeded);
  }, [data, period]);

  async function saveCosts() {
    setSaving(true);
    setSaveMessage("");
    try {
      const response = await fetch("/api/finance/costs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ products, period: periodCost, opex: opexRows, opexPeriod: period }),
      });
      const payload = await response.json();
      if (!response.ok) { setSaveMessage(payload.error || "Could not save."); return; }
      setSaveMessage("Saved.");
      load(false);
    } catch (caught) {
      setSaveMessage(caught.message || "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const updateProduct = (index, patch) => setProducts((rows) => rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));

  /* ------------------------------------------------------- build the sheet */
  const rows = useMemo(() => {
    if (!data) return [];
    const out = [];
    const num = (value, options = {}) => cell(money(value), { className: `xlNum${options.negative ? " xlNeg" : ""}${options.fill ? ` xl${options.fill}` : ""}`, ...options });

    /* ---- summary block ---- */
    out.push(title("SUMMARY"));
    out.push([
      cell("Total Sales", { className: "xlHead" }),
      cell("Duit Masuk", { className: "xlHead" }),
      cell("Nett Profit", { className: "xlHead" }),
      cell("Profit %", { className: "xlHead" }),
      cell("Unit ME", { className: "xlHead" }),
      cell("Orders", { className: "xlHead" }),
      cell("Settled", { className: "xlHead" }),
    ]);
    out.push([
      num(data.totalSales, { fill: "Yellow" }),
      num(data.duitMasuk, { fill: "Yellow" }),
      num(data.nettProfit, { fill: "Yellow", negative: data.nettProfit < 0 }),
      cell(`${(data.profitPercentage * 100).toFixed(2)}%`, { className: "xlNum xlYellow" }),
      cell(data.unitMe.toLocaleString(), { className: "xlNum xlYellow" }),
      cell(data.orderCount.toLocaleString(), { className: "xlNum" }),
      cell(`${data.settledOrders} / ${data.orderCount}`, { className: "xlNum" }),
    ]);
    out.push(spacer());

    /* ---- P&L block ---- */
    out.push(title("PROFIT & LOSS"));
    out.push([
      cell("Item", { className: "xlHead" }),
      cell("Amount", { className: "xlHead" }),
      cell("Source", { className: "xlHead" }),
      cell("Basis", { className: "xlHead", span: 4 }),
    ]);
    const plRow = (label, amount, source, basis, options = {}) => out.push([
      cell(label, { className: `xlLabel${options.strong ? " xlStrong" : ""}` }),
      num(amount, { fill: options.fill, negative: options.negative }),
      cell(SOURCE_LABEL[source], { className: `xlTag xlTag-${source}` }),
      cell(basis, { className: "xlNote", span: 4 }),
    ]);

    plRow(
      "Total Sales (Order Amount)",
      data.totalSales,
      "tiktok",
      data.basis === "payout" ? `${data.orderCount} orders paid out in this period` : `all ${data.orderCount} orders created in this period`,
    );
    if (data.pendingSales > 0) plRow("Less: sales not yet settled", -data.pendingSales, "tiktok", `${data.pendingOrders} orders still pending payout`, { negative: true });
    plRow("Settled sales", data.settledSales, "tiktok", `${data.settledOrders} settled orders`, { strong: true });
    plRow("Duit Masuk (Total settlement)", data.duitMasuk, "tiktok", `${(data.settlementRate * 100).toFixed(1)}% of settled sales`, { strong: true, fill: "Yellow" });
    plRow("Kos Produk", -data.kosProdukSettled, "manual", "settled orders only", { negative: true, fill: "Yellow" });
    plRow(
      "Kos Ads By Card",
      -data.adsCard,
      data.adsCardIsSynced ? "tiktok" : "manual",
      data.adsCardIsSynced ? "Business Center — card payments" : "typed; connect Business Center to measure it",
      { negative: true },
    );
    plRow(
      data.gmvPayIsDeductedFromPayout || data.adsGmvPayIsOverride ? "Kos Ads By GMV Pay" : data.adFeeSources?.length ? "Ads charged inside settlement" : "Kos Ads By GMV Pay",
      data.gmvPayIsDeductedFromPayout ? -data.adsGmvPay : data.adsGmvPay,
      data.adsGmvPayIsOverride ? "manual" : "tiktok",
      data.adsGmvPayIsOverride
        ? "manual override"
        : data.gmvPayIsDeductedFromPayout
          ? `${data.gmvPayTransactions} GMV Pay deductions taken from your payouts`
        : data.adsGmvPayIsSynced
          ? "Business Center — GMV Pay"
        : data.adFeeSources?.length
          ? `${data.adFeeSources.join(", ")} — already deducted, not GMV Pay top-ups`
          : "no ad fees found in settlement",
    );
    plRow("Ad Credit", data.adCredit, "manual", "not netted off profit");
    if (data.otherCost !== 0) plRow("Other cost", -data.otherCost, "manual", "whole month", { negative: true });
    plRow(`WHT ${(data.whtRate * 100).toFixed(0)}% (To Pay)`, -data.wht, "calc", "on card + GMV Pay ad spend", { negative: true, fill: "Yellow" });
    if (data.fulfilmentCost > 0) plRow("Fulfilment", -data.fulfilmentCost, "calc", `${data.shippedParcels.toLocaleString()} parcels shipped x ${money(data.fulfilmentRate)}`, { negative: true });
    if (data.opexTotal > 0) {
      out.push([
        cell("Operating profit", { className: "xlLabel xlStrong" }),
        cell(money(data.operatingProfit), { className: `xlNum${data.operatingProfit < 0 ? " xlNeg" : ""}` }),
        cell("Calc", { className: "xlTag xlTag-calc" }),
        cell("before fixed running costs", { className: "xlNote", span: 4 }),
      ]);
      for (const [category, amount] of Object.entries(data.opexByCategory || {})) {
        plRow(`OPEX — ${category}`, -amount, "manual", (data.opexLines || []).filter((line) => line.category === category).map((line) => line.label).join(", "), { negative: true });
      }
    }
    out.push([
      cell("NETT PROFIT", { className: "xlTotalLabel" }),
      cell(money(data.nettProfit), { className: `xlTotal xlNum${data.nettProfit < 0 ? " xlNeg" : ""}` }),
      cell(`${(data.profitPercentage * 100).toFixed(2)}%`, { className: "xlTotal xlNum" }),
      cell("of settled sales · margin on money received " + `${(data.marginOnSettlement * 100).toFixed(2)}%`, { className: "xlTotal", span: 4 }),
    ]);
    out.push(spacer());

    /* ---- bundles block ---- */
    out.push(title("QUANTITY BY BUNDLE"));
    out.push([
      cell("Bundle", { className: "xlHead" }),
      cell("Qty", { className: "xlHead" }),
      cell("Unit Cost", { className: "xlHead" }),
      cell("Bottles", { className: "xlHead" }),
      cell("Kos Produk", { className: "xlHead" }),
      cell("", { className: "xlHead", span: 2 }),
    ]);
    if (!data.bundles.length) out.push([cell("No orders in this month yet.", { className: "xlNote", span: COLUMNS.length })]);
    for (const bundle of data.bundles) {
      out.push([
        cell(bundle.bundle, { className: `xlLabel${bundle.matched ? "" : " xlUnmapped"}` }),
        cell(bundle.quantity.toLocaleString(), { className: "xlNum" }),
        cell(bundle.matched ? money(bundle.unitCost) : "—", { className: "xlNum" }),
        cell(bundle.matched ? (bundle.bottles * bundle.quantity).toLocaleString() : "—", { className: "xlNum" }),
        cell(bundle.matched ? money(bundle.totalCost) : "—", { className: "xlNum" }),
        cell(bundle.matched ? "" : "no cost mapped", { className: "xlNote xlWarnCell", span: 2 }),
      ]);
    }
    out.push([
      cell("TOTAL", { className: "xlTotalLabel" }),
      cell(data.totalQuantity.toLocaleString(), { className: "xlTotal xlNum" }),
      cell("", { className: "xlTotal" }),
      cell(data.unitMe.toLocaleString(), { className: "xlTotal xlNum" }),
      cell(money(data.kosProduk), { className: "xlTotal xlNum" }),
      cell("", { className: "xlTotal", span: 2 }),
    ]);
    out.push(spacer());

    /* ---- creator leaderboard ---- */
    if (data.leaderboard?.length) {
      out.push(spacer());
      out.push(title("PROFIT BY AFFILIATE"));
      out.push([
        cell("Creator", { className: "xlHead" }),
        cell("Orders", { className: "xlHead" }),
        cell("Sales", { className: "xlHead" }),
        cell("Settled", { className: "xlHead" }),
        cell("Kos Produk", { className: "xlHead" }),
        cell("Profit", { className: "xlHead" }),
        cell("Margin", { className: "xlHead" }),
      ]);
      for (const row of data.leaderboard) {
        out.push([
          cell(row.creator, { className: "xlLabel", title: row.contentTypes.join(", ") }),
          cell(row.settledOrders + "/" + row.orders, { className: "xlNum" }),
          cell(money(row.sales), { className: "xlNum" }),
          cell(money(row.settlement), { className: "xlNum" }),
          cell(money(row.cogs), { className: "xlNum" }),
          cell(money(row.profit), { className: "xlNum" + (row.profit < 0 ? " xlNeg" : "") }),
          cell((row.margin * 100).toFixed(1) + "%", { className: "xlNum" }),
        ]);
      }
      const t = data.leaderboard.reduce((acc, row) => ({
        orders: acc.orders + row.orders, settled: acc.settled + row.settledOrders, sales: acc.sales + row.sales,
        settlement: acc.settlement + row.settlement, cogs: acc.cogs + row.cogs, profit: acc.profit + row.profit,
      }), { orders: 0, settled: 0, sales: 0, settlement: 0, cogs: 0, profit: 0 });
      out.push([
        cell("TOTAL", { className: "xlTotalLabel" }),
        cell(t.settled + "/" + t.orders, { className: "xlTotal xlNum" }),
        cell(money(t.sales), { className: "xlTotal xlNum" }),
        cell(money(t.settlement), { className: "xlTotal xlNum" }),
        cell(money(t.cogs), { className: "xlTotal xlNum" }),
        cell(money(t.profit), { className: "xlTotal xlNum" }),
        cell(t.settlement > 0 ? ((t.profit / t.settlement) * 100).toFixed(1) + "%" : "-", { className: "xlTotal xlNum" }),
      ]);
    }

    if (!data.leaderboard?.length) {
      out.push(spacer());
      out.push(title("PROFIT BY AFFILIATE"));
      out.push([cell("No affiliate data yet. Open Cost setup and hit Sync from TikTok to split every order by creator.", { className: "xlNote", span: COLUMNS.length })]);
    }

    /* ---- settlement breakdown block ---- */
    out.push(title("TIKTOK SHOP SETTLEMENT BREAKDOWN"));
    if (!data.lines.length) {
      out.push([cell("No settlement data for this month yet. Payouts appear after TikTok closes the statement.", { className: "xlNote", span: COLUMNS.length })]);
    } else {
      out.push([
        cell("Line", { className: "xlHead", span: 3 }),
        cell("Amount", { className: "xlHead" }),
        cell("Share of revenue", { className: "xlHead", span: 3 }),
      ]);
      const base = Math.abs(data.revenueAmount) || Math.abs(data.settledSales) || 1;
      for (const group of GROUP_ORDER) {
        const lines = data.lines.filter((line) => line.group === group);
        if (!lines.length) continue;
        const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
        out.push([
          cell(GROUP_LABELS[group], { className: "xlGroup", span: 3 }),
          cell(money(subtotal), { className: "xlGroup xlNum" }),
          cell("", { className: "xlGroup", span: 3 }),
        ]);
        for (const line of lines) {
          const share = Math.min(100, (Math.abs(line.amount) / base) * 100);
          out.push([
            cell(line.label, { className: "xlLabel xlIndent", span: 3, title: line.key }),
            cell(money(line.amount), { className: `xlNum${line.amount < 0 ? " xlNeg" : ""}` }),
            cell(
              <span className="xlBar"><i className={line.amount < 0 ? "down" : "up"} style={{ width: `${share.toFixed(1)}%` }} /><em>{share.toFixed(1)}%</em></span>,
              { className: "xlBarCell", span: 3 },
            ),
          ]);
        }
      }
      out.push([
        cell("DUIT MASUK (TOTAL SETTLEMENT)", { className: "xlTotalLabel", span: 3 }),
        cell(money(data.duitMasuk), { className: "xlTotal xlNum" }),
        cell("", { className: "xlTotal", span: 3 }),
      ]);
      if (data.reserveAmount !== 0) {
        out.push([
          cell("Held in reserve (not yet paid out)", { className: "xlLabel", span: 3 }),
          cell(money(data.reserveAmount), { className: "xlNum" }),
          cell("", { span: 3 }),
        ]);
      }
    }

    return out;
  }, [data, money]);

  const settledPercent = data && data.orderCount > 0 ? (data.settledOrders / data.orderCount) * 100 : 0;

  return (
    <main className={compact ? "finPane" : "finShell"}>
      <header className={compact ? "finHeaderCompact" : "finHeader"}>
        {compact ? (
          <b className="finPaneTitle">Financial dashboard</b>
        ) : (
          <div>
            <p className="eyebrow">TIKTOK SHOP · {data?.currency || "MYR"}</p>
            <h1>Financial dashboard</h1>
          </div>
        )}
        <div className="finControls">
          <div className="rangeChips" role="tablist" aria-label="Date range">
            {RANGES.map((entry) => (
              <button
                key={entry.key}
                role="tab"
                aria-selected={rangeKey === entry.key}
                className={rangeKey === entry.key ? "on" : ""}
                onClick={() => setRangeKey(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="rangeChips basisChips" role="tablist" aria-label="Accounting basis">
            <button role="tab" aria-selected={basis === "order"} className={basis === "order" ? "on" : ""} onClick={() => setBasis("order")} title="Every order created in this period, plus everything it will ever pay out">by order date</button>
            <button role="tab" aria-selected={basis === "payout"} className={basis === "payout" ? "on" : ""} onClick={() => setBasis("payout")} title="Money that actually settled in this period, whenever the order was placed">by payout date</button>
          </div>
          {rangeKey === "month" && (
            <select value={period} onChange={(event) => setPeriod(event.target.value)} aria-label="Month">
              {months.map((month) => <option key={month.value} value={month.value}>{month.label}</option>)}
            </select>
          )}
          <button className="finGhost" onClick={() => setShowCosts((open) => !open)}>{showCosts ? "Hide cost setup" : "Cost setup"}</button>
          <button className={`finLive${live ? " on" : ""}`} onClick={() => setLive((value) => !value)} title="Re-read every 30s">
            <i />{live ? "Live" : "Paused"}
          </button>
          <button
            className="finGhost"
            onClick={() => load(true)}
            disabled={syncing}
            title="Not required — the hourly job keeps this current. Use this for a deep 90-day backfill or to refresh immediately."
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          {!compact && <a className="finBack" href="/">Back</a>}
        </div>
      </header>

      {data && <p className="finFresh">{freshness(data.lastSynced, tick)}{!live ? " · live paused" : showCosts ? " · live paused while editing costs" : " · auto-syncs hourly, page re-reads every 30s"}</p>}
      {error && <p className="finError">{error}</p>}
      {data?.sync?.errors?.length > 0 && data.sync.errors.map((message) => <p key={message} className="finWarn">{message}</p>)}
      {data?.sync && !data.sync.errors.length && (
        <p className="finOk">
          Synced {data.sync.orders} orders and {data.sync.settlements} settlement transactions from {data.sync.statements} payout statements
          {data.sync.statementsSkipped ? ` (${data.sync.statementsSkipped} already stored)` : ""}
          {data.sync.sellerName ? ` · ${data.sync.sellerName}` : ""}.
        </p>
      )}
      {data?.lineDrift?.length > 0 && (
        <p className="finWarn">
          A breakdown subtotal does not match the total TikTok reports for it
          ({data.lineDrift.map((entry) => `${entry.group} off by ${money(entry.drift)}`).join(", ")}).
          Re-sync with <code>&amp;refresh=1</code>; until then trust Duit Masuk over the breakdown.
        </p>
      )}
      {data?.pendingOrders > 0 && (
        <p className="finWarn">
          <b>This month is still paying out.</b> {data.settledOrders} of {data.orderCount} orders have settled ({settledPercent.toFixed(0)}%),
          leaving {money(data.pendingSales)} of sales pending. The P&amp;L covers settled orders only, so it is a true margin on money received — not the month&apos;s final result.
        </p>
      )}
      {Math.abs(data?.gmvPayOverrideDrift || 0) > 1 && (
        <p className="finWarn">
          Your GMV Pay override of {money(data.adsGmvPay)} differs from the {money(data.gmvPayMeasured)} TikTok actually deducted
          across {data.gmvPayTransactions} payments, so profit is off by {money(Math.abs(data.gmvPayOverrideDrift))}.
          Clear the override in Cost setup to use the measured figure.
        </p>
      )}
      {Math.abs(data?.unmatchedPayout || 0) > 1 && (
        <p className="finWarn">
          {money(data.unmatchedPayout)} settled this period across {data.unmatchedPayoutOrders} orders that carry no matching sales or cost here —
          typically refunds on cancelled orders, or orders created before the synced window. Excluded from the P&amp;L so income and cost describe the
          same orders; it is still real money moving through your account.
        </p>
      )}
      {data?.unmappedSkus?.length > 0 && (
        <p className="finWarn">
          {data.unmappedSkus.length} SKU{data.unmappedSkus.length === 1 ? " has" : "s have"} no product cost mapped
          ({data.unmappedSkus.slice(0, 3).map((sku) => sku.skuKey).join(", ")}{data.unmappedSkus.length > 3 ? "…" : ""}).
          Kos Produk reads low and profit reads high until you map {data.unmappedSkus.length === 1 ? "it" : "them"} in Cost setup.
        </p>
      )}

      {loading && !data && <p className="finMuted">Loading…</p>}

      {data && (
        <>
        {showCosts && (
          <section className="costPanel">
            <div className="costPanelHead">
              <div>
                <h2>Cost setup</h2>
                <p>The only numbers TikTok Shop cannot supply: what each bundle costs to make, and ad spend billed to a card in Ads Manager.</p>
              </div>
              <div className="costPanelActions">
                <button className="primary" onClick={saveCosts} disabled={saving}>{saving ? "Saving…" : "Save cost setup"}</button>
                {saveMessage && <span className="finMuted">{saveMessage}</span>}
                <button className="costClose" onClick={() => setShowCosts(false)} title="Close">✕</button>
              </div>
            </div>

            <h3 className="costSubhead">Affiliate attribution</h3>
            <p className="finMuted costNote">
              Which creator drove each order is the one thing TikTok&apos;s APIs never expose. Upload the Affiliate export
              TikTok does expose it on the affiliate endpoint, so Sync pulls it directly. The CSV upload stays for backfilling
              further than the API reaches, or if your authorization lacks the affiliate scope.
            </p>
            <div className="costUpload">
              <button className="primary" onClick={syncAffiliates} disabled={importing}>
                {importing ? "Working..." : "Sync from TikTok"}
              </button>
              <label className="finGhost">
                {importing ? "Importing..." : "Choose affiliate CSV"}
                <input type="file" accept=".csv,text/csv" hidden onChange={importAffiliates} disabled={importing} />
              </label>
              {importMessage && <span className="finMuted">{importMessage}</span>}
            </div>

            <h3 className="costSubhead">Product cost per SKU</h3>
            <div className="costScroll">
              <table className="costTable">
                <thead>
                  <tr><th>SKU</th><th>TikTok name</th><th>Bundle name</th><th>Unit cost</th><th>Bottles</th><th>Sold</th></tr>
                </thead>
                <tbody>
                  {products.length === 0 && <tr><td colSpan={6} className="costEmpty">No SKUs yet — hit Sync now first.</td></tr>}
                  {products.map((product, index) => (
                    <tr key={product.skuKey}>
                      <th><code>{product.skuKey}</code></th>
                      <td className="costName">{product.label}</td>
                      <td><input value={product.bundle} onChange={(event) => updateProduct(index, { bundle: event.target.value })} /></td>
                      <td><input type="number" step="0.01" value={product.unitCost} onChange={(event) => updateProduct(index, { unitCost: Number(event.target.value) })} /></td>
                      <td><input type="number" step="1" value={product.bottles} onChange={(event) => updateProduct(index, { bottles: Number(event.target.value) })} /></td>
                      <td className="costSold">{product.quantity.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="costSubhead">Operating expenses — {period}</h3>
            <p className="finMuted costNote">Fixed monthly running costs. A settlement-only P&amp;L flatters the business because none of this appears in it.</p>
            <div className="costScroll">
              <table className="costTable">
                <thead><tr><th>Category</th><th>Item</th><th>Amount / month</th></tr></thead>
                <tbody>
                  {opexRows.map((row, index) => (
                    <tr key={`${row.category}-${row.label}-${index}`}>
                      <th>{row.category}</th>
                      <td className="costName">{row.label}</td>
                      <td><input type="number" step="0.01" value={row.amount} onChange={(event) => setOpexRows(rows => rows.map((r, i) => i === index ? { ...r, amount: Number(event.target.value) } : r))} /></td>
                    </tr>
                  ))}
                  <tr><th>Total</th><td /><td className="costSold"><b>{money(opexRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0))}</b></td></tr>
                </tbody>
              </table>
            </div>

            <h3 className="costSubhead">Ad spend &amp; tax — {period}</h3>
            <p className="finMuted costNote">GMV Pay syncs from TikTok&apos;s GMV Max ad fee. Card-billed spend and ad credits live in TikTok Ads Manager, which a TikTok Shop authorization cannot reach.</p>
            <div className="costFields">
              <label>Kos Ads By Card<input type="number" step="0.01" value={periodCost.adsCard} onChange={(event) => setPeriodCost({ ...periodCost, adsCard: Number(event.target.value) })} /></label>
              <div className="costField">
                <div className="costFieldHead">
                  <span>Kos Ads By GMV Pay</span>
                  <button className="finLink" onClick={() => setPeriodCost({ ...periodCost, adsGmvPayOverride: periodCost.adsGmvPayOverride === null ? Number((data.adsGmvPayIsOverride ? 0 : data.adsGmvPay).toFixed(2)) : null })}>
                    {periodCost.adsGmvPayOverride === null ? "Override" : "Use synced"}
                  </button>
                </div>
                {periodCost.adsGmvPayOverride === null
                  ? <><b>{money(data.adsGmvPayIsOverride ? 0 : data.adsGmvPay)}</b><small className="finFromTikTok">Synced from TikTok</small></>
                  : <input type="number" step="0.01" value={periodCost.adsGmvPayOverride} onChange={(event) => setPeriodCost({ ...periodCost, adsGmvPayOverride: Number(event.target.value) })} />}
              </div>
              <label>Ad Credit<input type="number" step="0.01" value={periodCost.adCredit} onChange={(event) => setPeriodCost({ ...periodCost, adCredit: Number(event.target.value) })} /></label>
              <label>Other cost<input type="number" step="0.01" value={periodCost.otherCost} onChange={(event) => setPeriodCost({ ...periodCost, otherCost: Number(event.target.value) })} /></label>
              <label>WHT rate (%)<input type="number" step="0.1" value={(periodCost.whtRate * 100).toFixed(1)} onChange={(event) => setPeriodCost({ ...periodCost, whtRate: Number(event.target.value) / 100 })} /></label>
              <label>Fulfilment per parcel<input type="number" step="0.01" value={periodCost.fulfilmentRate ?? 0} onChange={(event) => setPeriodCost({ ...periodCost, fulfilmentRate: Number(event.target.value) })} /></label>
              <label>COGS markup (%)<input type="number" step="1" value={periodCost.cogsMarkupPct ?? 0} onChange={(event) => setPeriodCost({ ...periodCost, cogsMarkupPct: Number(event.target.value) })} /></label>
              <div className="costField"><span>WHT to pay</span><b>{money(periodCost.whtRate * (periodCost.adsCard + (periodCost.adsGmvPayOverride ?? (data.adsGmvPayIsOverride ? 0 : data.adsGmvPay))))}</b></div>
            </div>
          </section>
        )}

        {/* Mobile: the 7-column grid is unusable at 390px, so the same numbers are
            stacked as cards. Desktop hides this and shows the sheet instead. */}
        <div className="mStack">
          <div className="mKpis">
            <article><span>Total Sales</span><b>{money(data.totalSales)}</b><small>{data.orderCount} orders</small></article>
            <article><span>Duit Masuk</span><b>{money(data.duitMasuk)}</b><small>{data.settledOrders} of {data.orderCount} settled</small></article>
            <article className={data.nettProfit < 0 ? "bad" : "good"}><span>Nett Profit</span><b>{money(data.nettProfit)}</b><small>{(data.profitPercentage * 100).toFixed(2)}% of settled sales</small></article>
            <article><span>Unit ME</span><b>{data.unitMe.toLocaleString()}</b><small>{data.totalQuantity.toLocaleString()} units sold</small></article>
          </div>

          <section className="mCard">
            <p className="mEyebrow">// profit &amp; loss</p>
            <MRow label="Total Sales (Order Amount)" value={money(data.totalSales)} source="tiktok" />
            {data.pendingSales > 0 && <MRow label="Less: not yet settled" value={money(-data.pendingSales)} source="tiktok" deduct />}
            <MRow label="Settled sales" value={money(data.settledSales)} source="tiktok" strong />
            <MRow label="Duit Masuk" value={money(data.duitMasuk)} source="tiktok" strong />
            <MRow label="Kos Produk" value={money(-data.kosProdukSettled)} source="manual" deduct />
            <MRow label="Kos Ads By Card" value={money(-data.adsCard)} source={data.adsCardIsSynced ? "tiktok" : "manual"} deduct />
            <MRow
              label="Kos Ads By GMV Pay"
              value={money(data.gmvPayIsDeductedFromPayout ? -data.adsGmvPay : data.adsGmvPay)}
              source={data.adsGmvPayIsOverride ? "manual" : "tiktok"}
              deduct={data.gmvPayIsDeductedFromPayout}
            />
            <MRow label="Ad Credit" value={money(data.adCredit)} source="manual" />
            {data.otherCost !== 0 && <MRow label="Other cost" value={money(-data.otherCost)} source="manual" deduct />}
            <MRow label={`WHT ${(data.whtRate * 100).toFixed(0)}%`} value={money(-data.wht)} source="calc" deduct />
            {data.fulfilmentCost > 0 && <MRow label={`Fulfilment (${data.shippedParcels} parcels)`} value={money(-data.fulfilmentCost)} source="calc" deduct />}
            {Object.entries(data.opexByCategory || {}).map(([category, amount]) => (
              <MRow key={category} label={`OPEX — ${category}`} value={money(-amount)} source="manual" deduct />
            ))}
            <div className="mTotal"><span>Nett Profit</span><b className={data.nettProfit < 0 ? "neg" : ""}>{money(data.nettProfit)}</b></div>
          </section>

          <section className="mCard">
            <p className="mEyebrow">// quantity by bundle</p>
            {data.bundles.length === 0 && <p className="mEmpty">No orders in this range yet.</p>}
            {data.bundles.map((bundle) => (
              <div key={bundle.bundle} className={`mBundle${bundle.matched ? "" : " unmapped"}`}>
                <div className="mBundleTop"><b>{bundle.bundle}</b><span>{bundle.quantity.toLocaleString()} sold</span></div>
                <div className="mBundleFoot">
                  {bundle.matched
                    ? <>{money(bundle.unitCost)} each · {(bundle.bottles * bundle.quantity).toLocaleString()} bottles · {money(bundle.totalCost)}</>
                    : <>no cost mapped</>}
                </div>
              </div>
            ))}
          </section>

          {!data.leaderboard?.length && (
            <section className="mCard">
              <p className="mEyebrow">// profit by affiliate</p>
              <p className="mEmpty">No affiliate data yet. Open Cost setup and upload the Affiliate export to split every order by creator.</p>
            </section>
          )}
          {data.leaderboard?.length > 0 && (
            <section className="mCard">
              <p className="mEyebrow">// profit by affiliate</p>
              {data.leaderboard.map((row) => (
                <div key={row.creator} className="mBundle">
                  <div className="mBundleTop"><b>{row.creator}</b><span>{money(row.profit)}</span></div>
                  <div className="mBundleFoot">{row.settledOrders}/{row.orders} settled - sales {money(row.sales)} - {(row.margin * 100).toFixed(1)}% margin</div>
                </div>
              ))}
            </section>
          )}

          {data.lines.length > 0 && (
            <section className="mCard">
              <p className="mEyebrow">// settlement breakdown</p>
              {GROUP_ORDER.map((group) => {
                const lines = data.lines.filter((line) => line.group === group);
                if (!lines.length) return null;
                const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
                return (
                  <div key={group} className="mGroup">
                    <div className="mGroupHead"><span>{GROUP_LABELS[group]}</span><b>{money(subtotal)}</b></div>
                    {lines.map((line) => (
                      <div key={`${line.group}:${line.key}`} className="mLine">
                        <span>{line.label}</span>
                        <b className={line.amount < 0 ? "neg" : ""}>{money(line.amount)}</b>
                      </div>
                    ))}
                  </div>
                );
              })}
              <div className="mTotal"><span>Duit Masuk</span><b>{money(data.duitMasuk)}</b></div>
            </section>
          )}
        </div>

        <div className="xlFrame">
          <div className="xlScroll">
            <table className="xl">
              <thead>
                <tr>
                  <th className="xlCorner" />
                  {COLUMNS.map((column) => <th key={column} className="xlColHead">{column}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((cells, rowIndex) => (
                  <tr key={rowIndex} className={cells.length === 0 ? "xlSpacer" : undefined}>
                    <th className="xlRowNum">{rowIndex + 1}</th>
                    <SheetRow cells={cells} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="xlTabs"><span className="xlTab on">{rangeLabel(rangeKey, period)}</span><span className="xlTabHint">Values marked TikTok are measured; Manual are entered by you.</span></div>
        </div>
        </>
      )}
    </main>
  );
}

function MRow({ label, value, source, deduct, strong }) {
  return (
    <div className={`mRow${strong ? " strong" : ""}`}>
      <span>{label}<i className={`finTag ${source}`}>{SOURCE_LABEL[source]}</i></span>
      <b className={deduct ? "neg" : ""}>{value}</b>
    </div>
  );
}

/** Emits a row's cells and pads the remainder so the grid never has ragged edges. */
function SheetRow({ cells }) {
  const used = cells.reduce((total, item) => total + (item.span || 1), 0);
  const padding = Math.max(0, COLUMNS.length - used);
  return (
    <>
      {cells.map((item, index) => (
        <td key={index} className={item.className} colSpan={item.span || 1} title={item.title}>{item.value}</td>
      ))}
      {Array.from({ length: padding }, (_, index) => <td key={`pad-${index}`} />)}
    </>
  );
}
