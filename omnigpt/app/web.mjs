// Read-only text browser for the agents: search the web, open a page, follow its numbered links.
// Pages are fetched by the backend (never by the agent's own code), with the same address rules as downloads.
import { checkUrl } from "./tools.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "-", ndash: "-", hellip: "...", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', copy: "(c)" };
const dec = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; }
  return ENT[e.toLowerCase()] ?? m;
});
const plain = (s) => dec(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

async function get(u0) {
  let url = await checkUrl(u0), res;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, { redirect: "manual", headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5", "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(20000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { url = await checkUrl(new URL(res.headers.get("location"), url).href); continue; }
    break;
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (type && !/text\/|json|xml|html/.test(type)) throw new Error("not a text page (" + type + "); use download_file if the user wants the file");
  const rd = res.body.getReader(), chunks = []; let n = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; chunks.push(value); if (n > 2e6) { rd.cancel(); break; } }
  return { url, type, body: Buffer.concat(chunks).toString("utf8") };
}

export function pageText(html, base) {
  const title = plain((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""), links = [];
  let s = html.replace(/<(script|style|noscript|svg|template|head|nav|footer)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (m, a, b, t) => {
    const txt = plain(t); let href;
    try { href = new URL(dec(a || b), base).href; } catch { return txt; }
    if (!/^https?:/.test(href) || !txt) return txt;
    let k = links.findIndex((l) => l.href === href);
    if (k < 0) { links.push({ href, text: txt.slice(0, 80) }); k = links.length - 1; }
    return txt + " [" + (k + 1) + "]";
  });
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|ul|ol|table|blockquote|pre)>|<br\s*\/?>/gi, "\n").replace(/<li\b[^>]*>/gi, "- ").replace(/<[^>]+>/g, " ");
  s = dec(s).replace(/[ \t\f\v ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text: s, links };
}

export async function webOpen(i) {
  const r = await get(i.url), start = Math.max(0, Number(i.offset) || 0), WIN = 6000;
  let title = "", text = r.body, links = [];
  if (/html/.test(r.type) || /^\s*<(!doctype|html)/i.test(r.body)) ({ title, text, links } = pageText(r.body, r.url));
  const end = Math.min(text.length, start + WIN);
  return `Title: ${title || "(none)"}\nURL: ${r.url.href}\nShowing characters ${start}-${end} of ${text.length}${end < text.length ? ` (call web_open again with offset ${end} for more)` : ""}\n\n${text.slice(start, end)}`
    + (links.length ? "\n\nLinks (open one with web_open):\n" + links.slice(0, 20).map((l, k) => `[${k + 1}] ${l.text} - ${l.href.slice(0, 140)}`).join("\n") : "");
}

export async function webSearch(i) {
  const q = String(i.query || "").trim(); if (!q) throw new Error("query is required");
  const r = await get("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q));
  const out = [], re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|$)/g; let m;
  while ((m = re.exec(r.body)) && out.length < 8) {
    let href = dec(m[1]); const u = /[?&]uddg=([^&]+)/.exec(href);
    if (u) href = decodeURIComponent(u[1]); else if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:/.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue; // skip ads
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(m[3]);
    out.push(`${out.length + 1}. ${plain(m[2])}\n   ${href}\n   ${sn ? plain(sn[1]) : ""}`);
  }
  if (!out.length) throw new Error("the search engine returned no results (it may be rate-limiting); try again or open a known site with web_open");
  return `Search results for "${q}":\n\n${out.join("\n\n")}`;
}
