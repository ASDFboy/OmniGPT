// Built with Claude (Anthropic) - see CREDITS.md
// Finding things by meaning: text -> vectors through the user's own OmniRoute (POST /v1/embeddings), with a small disk
// cache (model + sha256 of the text -> an 8-bit vector) so the same memory, skill or question is never embedded twice.
// Nothing runs in the background: the cache is loaded on first use and dropped from memory again after a few idle minutes.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const CFG_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OmniRouteChat");
const CACHE = path.join(CFG_DIR, "embed-cache.json");
const BATCH = 32, MAX_IN = 2000, CACHE_MAX = 6000, CACHE_BYTES = 8 * 1024 * 1024;
let OR_URL = process.env.OMNIROUTE_URL || "http://127.0.0.1:20128", OR_KEY = () => "";
export function embedSetup(url, keyFn) { OR_URL = String(url || OR_URL).replace(/\/$/, ""); if (keyFn) OR_KEY = keyFn; models = { at: 0, ids: [], err: "" }; }
const orFetch = (p, opts = {}) => fetch(OR_URL + p, { ...opts, headers: { ...(OR_KEY() ? { authorization: "Bearer " + OR_KEY() } : {}), "content-type": "application/json", ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 60000) });

// The page keeps its settings in kv/orc.settings.json; the backend only reads the two that concern it.
export function meaningSettings() {
  for (const f of ["orc.settings.json", "orc.settings.json.bak"]) {
    try { const s = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "kv", f), "utf8")) || {}; return { model: typeof s.embedModel === "string" && s.embedModel.trim() ? s.embedModel.trim() : "auto", docs: s.docMeaning === true }; } catch {}
  }
  return { model: "auto", docs: false };
}

// ---------- which embedding models OmniRoute offers: on this PC first (the text never leaves it), then the free providers
// OmniGPT's Free mode uses (PROFILES.free in app.js), then the rest, each group in OmniRoute's own order
const LOCAL = /^(ollama|ollama-local|lmstudio|lm-studio|llama-cpp|llamacpp|lemonade|localai|vllm|local|jan|gpt4all)$/i;
const FREE = /^(gemini|groq|ddgw|unc)$/i;
const prov = (id) => String(id).split("/")[0].toLowerCase();
export const isLocalModel = (id) => LOCAL.test(prov(id));
let models = { at: 0, ids: [], err: "" };
export async function embedModels(force) {
  if (!force && Date.now() - models.at < (models.ids.length ? 600000 : 30000)) { if (models.err && !models.ids.length) throw new Error(models.err); return models.ids; }
  const ids = [], add = (id) => { id = String(id || ""); if (id && !ids.includes(id) && !/image|vision|multimodal/i.test(id)) ids.push(id); };
  let err = "";
  try { const r = await orFetch("/v1/embeddings", { timeout: 8000 }); if (r.ok) for (const m of (await r.json()).data || []) if (m && m.id) add(m.id); } catch {}
  try {
    const r = await orFetch("/v1/models", { timeout: 8000 });
    if (r.ok) { for (const m of (await r.json()).data || []) if (m && (/embed/i.test(String(m.id)) || m.type === "embedding")) add(m.id); }
    else err = `OmniRoute answered ${r.status} when listing models` + (r.status === 401 ? " (check the OmniRoute API key in Settings > Connection)" : "") + ".";
  } catch (e) { err = "OmniRoute is not reachable (" + String(e.cause?.code || e.message || e).slice(0, 80) + ")."; }
  const rank = (id) => (isLocalModel(id) ? 0 : FREE.test(prov(id)) ? 1 : 2);
  models = { at: Date.now(), ids: ids.map((id, i) => [id, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]), err: ids.length ? "" : err || NO_MODEL };
  if (!models.ids.length) throw new Error(models.err);
  return models.ids;
}
const NO_MODEL = "OmniRoute has no embedding model. Add a provider that offers embeddings in the OmniRoute console (Gemini's free tier does; a local one such as Ollama with nomic-embed-text keeps everything on this PC), or choose a model in Settings > Search by meaning.";
// "auto" -> the candidates in order; a specific id -> just that one; "off" -> refused
export async function modelsFor(want) {
  want = String(want || "auto").trim();
  if (/^off$/i.test(want)) throw new Error("Search by meaning is turned off (Settings > Search by meaning > Embedding model).");
  return /^(auto|automatic)$/i.test(want) ? (await embedModels()).slice(0, 3) : [want];
}

// ---------- vectors: unit length, stored as 8-bit numbers (a quarter of the size; ranking stays the same)
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, (x) => x / n); };
export const quant = (v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));
export function cosine(a, b) { // a: unit Float32Array; b: Float32Array or Int8Array
  if (!a || !b || a.length !== b.length) return 0; let d = 0, n = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; n += b[i] * b[i]; }
  return n ? d / Math.sqrt(n) : 0;
}

// ---------- disk cache
let mem = null, dirty = false, saveT = 0, idleT = 0;
const fromB64 = (s) => new Int8Array(Uint8Array.from(Buffer.from(s, "base64")).buffer);
function cache() {
  clearTimeout(idleT); idleT = setTimeout(dropCache, 180000); idleT.unref?.(); // idle for a few minutes: give the memory back
  if (mem) return mem;
  mem = new Map();
  try { const j = JSON.parse(fs.readFileSync(CACHE, "utf8")); for (const [k, v] of j.e || []) mem.set(k, fromB64(v)); } catch {}
  return mem;
}
function cachePut(k, q) {
  const m = cache(); m.delete(k); m.set(k, q); dirty = true;
  clearTimeout(saveT); saveT = setTimeout(flushCache, 1500); saveT.unref?.();
}
export function flushCache() {
  clearTimeout(saveT); if (!mem || !dirty) return;
  let bytes = 0; const keep = [];
  for (const e of [...mem].reverse()) { bytes += e[1].length * 1.34 + 80; if (keep.length >= CACHE_MAX || bytes > CACHE_BYTES) break; keep.push(e); } // the newest are kept
  keep.reverse(); mem = new Map(keep);
  try { fs.mkdirSync(CFG_DIR, { recursive: true }); const t = CACHE + ".tmp"; fs.writeFileSync(t, JSON.stringify({ v: 1, e: keep.map(([k, v]) => [k, Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64")]) })); fs.renameSync(t, CACHE); dirty = false; } catch {}
}
export function dropCache() { flushCache(); mem = null; } // also used by tests: the next call reads the disk copy
export function cacheInfo() { let n = 0; try { n = fs.statSync(CACHE).size; } catch {} return { entries: mem ? mem.size : null, bytes: n }; }
process.on("exit", () => { try { flushCache(); } catch {} });

// ---------- OmniRoute calls, in batches; a text already on its way is never sent twice
const pending = new Map();
async function call(model, texts) {
  let r;
  try { r = await orFetch("/v1/embeddings", { method: "POST", body: JSON.stringify({ model, input: texts }), timeout: 90000 }); }
  catch (e) { throw new Error(`OmniRoute is not reachable for embeddings (${String(e.cause?.code || e.message || e).slice(0, 80)}).`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Embedding model ${model} failed: ${String(j.error?.message || j.message || "HTTP " + r.status).slice(0, 240)}${r.status === 401 ? " (check the OmniRoute API key in Settings > Connection)" : ""}`);
  const d = (Array.isArray(j.data) ? j.data : []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((x) => x && x.embedding);
  if (d.length !== texts.length || d.some((v) => !Array.isArray(v) || !v.length || v.length !== d[0].length)) throw new Error(`Embedding model ${model} sent back no usable vectors.`);
  return d.map(unit);
}
async function vectorsWith(model, texts, useCache) {
  const keys = texts.map((t) => model + "\n" + sha(t)), out = new Array(texts.length), waits = [], todo = [];
  const c = useCache ? cache() : null, mine = new Map();
  keys.forEach((k, i) => {
    const hit = c && c.get(k); if (hit) { out[i] = hit; return; }
    const p = pending.get(k) || mine.get(k); if (p) { const w = p.then((v) => { out[i] = v; }); w.catch(() => {}); waits.push(w); return; }
    let ok, bad; const d = new Promise((a, b) => { ok = a; bad = b; }); d.catch(() => {}); d.ok = ok; d.bad = bad;
    mine.set(k, d); pending.set(k, d); todo.push(i);
  });
  const batches = []; for (let b = 0; b < todo.length; b += BATCH) batches.push(todo.slice(b, b + BATCH));
  let next = 0, failure = null;
  const worker = async () => { while (next < batches.length && !failure) { const idx = batches[next++];
    try { const v = await call(model, idx.map((i) => texts[i])); idx.forEach((i, n) => { const q = quant(v[n]); out[i] = useCache ? q : v[n]; if (useCache) cachePut(keys[i], q); mine.get(keys[i]).ok(out[i]); }); }
    catch (e) { failure = e; } } };
  try { await Promise.all([worker(), worker(), worker()].slice(0, Math.max(1, Math.min(3, batches.length)))); }
  finally { for (const i of todo) { const d = mine.get(keys[i]); if (out[i] === undefined) d.bad(failure || new Error("not embedded")); pending.delete(keys[i]); } }
  if (failure) throw failure;
  await Promise.all(waits);
  return out;
}
// texts -> unit vectors (Int8Array when cached, Float32Array otherwise). "auto" tries up to three models in turn.
export async function embed(texts, { model = "auto", cache: useCache = true } = {}) {
  const list = texts.map((t) => String(t ?? "").slice(0, MAX_IN) || " "), cands = await modelsFor(model); let last = null;
  for (const m of cands) {
    try { const vectors = list.length ? await vectorsWith(m, list, useCache) : []; if (cands.length > 1 && m !== cands[0]) models.ids = [m, ...models.ids.filter((x) => x !== m)]; return { model: m, vectors }; }
    catch (e) { last = e; }
  }
  throw last || new Error(NO_MODEL);
}
const deq = (v) => (v instanceof Float32Array ? v : Float32Array.from(v, (x) => x / 127));
// Short unrelated sentences: their scores show what "unrelated" looks like for this model, so the cut-off adapts to it.
const ANCHORS = ["The weather will be sunny tomorrow.", "Add two cups of flour and stir slowly.", "The match ended in a draw after extra time.", "Restart the router to fix the connection.", "The museum opens at nine on Sundays."];
// query + texts -> cosine scores, and `cut`: the score a text needs to count as related (median of everything + a margin)
export async function similar(query, texts, opts = {}) {
  const r = await embed([String(query), ...texts, ...ANCHORS], opts), q = unit(deq(r.vectors[0]));
  const all = r.vectors.slice(1).map((v) => cosine(q, v)), scores = all.slice(0, texts.length), mid = all.slice().sort((a, b) => a - b)[all.length >> 1] || 0;
  return { model: r.model, scores: scores.map((s) => +s.toFixed(4)), cut: +Math.max(0.2, mid + 0.06).toFixed(4) };
}
// POST /api/embed {texts, query?, model?}: with a query, scores; without, the vectors themselves
export async function embedApi(b) {
  const texts = Array.isArray(b && b.texts) ? b.texts.slice(0, 2000).map(String) : null;
  if (!texts) throw new Error("texts must be a list");
  const model = b.model || meaningSettings().model;
  if (b.query !== undefined && b.query !== null) { if (!String(b.query).trim()) throw new Error("query is empty"); return similar(String(b.query).slice(0, 4000), texts, { model }); }
  const r = await embed(texts, { model });
  return { model: r.model, vectors: r.vectors.map((v) => Array.from(deq(v), (x) => +x.toFixed(4))) };
}
