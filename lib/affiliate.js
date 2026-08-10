/**
 * Affiliate order import.
 *
 * TikTok's Orders and Finance APIs never say which creator drove a sale — that
 * lives only in the Affiliate export from Seller Center. So this is the one place
 * a file still has to be uploaded, and everything else about it is automated:
 * once an order is attributed, its settlement, cost and profit already exist.
 *
 * CSV only, deliberately. The export downloads as .xlsx, but every xlsx parser on
 * npm is either unmaintained or carries advisories, and "Save as CSV" is one step
 * — not worth a supply-chain risk in a finance path.
 */

/** Splits one CSV line, honouring quoted fields that contain commas or quotes. */
function splitLine(line) {
  const out = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') { value += '"'; index += 1; }
        else quoted = false;
      } else value += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { out.push(value); value = ""; continue; }
    value += char;
  }
  out.push(value);
  return out.map((cell) => cell.trim());
}

export function parseCsv(text) {
  // Strip a BOM, which Excel writes and which would otherwise corrupt the first header.
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitLine(lines[0]);
  const rows = lines.slice(1).map((line) => splitLine(line));
  return { headers, rows };
}

const norm = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Locates the columns we need.
 *
 * Header matching first, because TikTok renames and reorders columns between
 * markets and exports. The positional fallbacks are the ones SulamX relies on
 * (L / M / S), used only when a header cannot be recognised.
 */
export function detectColumns(headers) {
  const find = (candidates, fallback) => {
    for (const candidate of candidates) {
      const index = headers.findIndex((header) => norm(header) === norm(candidate));
      if (index >= 0) return index;
    }
    for (const candidate of candidates) {
      const index = headers.findIndex((header) => norm(header).includes(norm(candidate)));
      if (index >= 0) return index;
    }
    return fallback;
  };
  return {
    orderId: find(["order id", "orderid", "order no", "order number"], 0),
    creator: find(["creator username", "username", "creator", "affiliate username"], 11),
    contentType: find(["content type", "contenttype", "source", "channel"], 12),
    commissionBase: find(["actual commission base", "commission base", "estimated commission base"], 18),
    commission: find(["actual commission", "estimated commission", "commission"], -1),
  };
}

const cleanOrderId = (value) => String(value || "").replace(/^["'\s]+|["'\s]+$/g, "").replace(/\.0$/, "");

function num(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Turns a parsed export into attribution rows.
 *
 * An order can appear on several lines (one per item), so it is collapsed to one
 * creator per order — otherwise a two-item order would count its revenue twice on
 * the leaderboard.
 */
export function buildAttributions(headers, rows, columns) {
  const map = new Map();
  let skipped = 0;
  for (const row of rows) {
    const orderId = cleanOrderId(row[columns.orderId]);
    const creator = String(row[columns.creator] || "").trim();
    if (!orderId || !creator) { skipped += 1; continue; }
    const existing = map.get(orderId);
    const commissionBase = num(row[columns.commissionBase]);
    const commission = columns.commission >= 0 ? num(row[columns.commission]) : 0;
    if (existing) {
      // Same order, another line: keep the creator, accumulate the money.
      existing.commissionBase += commissionBase;
      existing.commission += commission;
      continue;
    }
    map.set(orderId, {
      orderId,
      creator,
      contentType: String(row[columns.contentType] || "").trim() || null,
      commissionBase,
      commission,
    });
  }
  return { attributions: [...map.values()], skipped };
}
