// utils/index.js
'use strict';

// --- General helpers you can import anywhere ---

function getLatestTwitterProfileLink(username) {
  if (!username) return null;
  const raw = String(username).trim();
  if (!raw) return null;

  if (/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\//i.test(raw)) {
    const normalized = raw
      .replace(/^https?:\/\/(www\.)?twitter\.com\//i, 'https://x.com/')
      .replace(/^https?:\/\/(www\.)?x\.com\//i, 'https://x.com/')
      .replace(/\/+$/, '');

    if (/^https?:\/\//i.test(normalized)) {
      return normalized;
    }

    return `https://${normalized}`;
  }

  const clean = raw.replace(/^@/, '').replace(/\/+$/, '');
  return `https://x.com/${clean}`;
}

// MarkdownV2 helpers (Telegram)
function escapeMDV2(input = "") {
  const s = String(input);
  return s
    .replace(/\\/g, "\\\\") // backslash first
    .replace(/[_*[\]()~`>#+\-=|{}.!]/g, (m) => "\\" + m);
}

function escapeUrlMDV2(url = "") {
  return String(url).replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function linkMDV2(text, url) {
  const t = escapeMDV2(text);
  const u = escapeUrlMDV2(url);
  return `[${t}](${u})`;
}

// Arrays/CSV helpers
function arrFromMaybeSet(v) {
  if (v instanceof Set) return Array.from(v);
  if (Array.isArray(v)) return v;
  if (!v) return [];
  if (typeof v === "string") return v.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}

function toArrMaybeCSV(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  if (typeof v === "string") return v.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}

// Requests normalizer (handles array-or-object rows)
function normalizeRequests(rows = []) {
  return rows.map((r) => {
    if (Array.isArray(r)) {
      // Expecting [from, to, status, timestamp]
      return {
        from: String(r[0]),
        to: String(r[1]),
        status: String(r[2] || "").toLowerCase(),
      };
    }
    return {
      from: String(r.from),
      to: String(r.to),
      status: String(r.status || "").toLowerCase(),
    };
  });
}

module.exports = {
  getLatestTwitterProfileLink,
  escapeMDV2,
  escapeUrlMDV2,
  linkMDV2,
  arrFromMaybeSet,
  toArrMaybeCSV,
  normalizeRequests,
};
