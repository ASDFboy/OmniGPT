// Built with Claude (Anthropic) - see CREDITS.md
// Finding things by meaning: embeddings through a stand-in OmniRoute (deterministic word vectors where synonyms share a
// direction, so "car" matches "automobile"), the disk cache, memories and skills picked by meaning (word overlap when
// embeddings are off, failing or slow), recall, and search_meaning over files (opt-in, incremental, never outside the
// allowed folders or into protected ones). Run: node meaning-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-meaningtest-"));
const tools = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
const E = await import(pathToFileURL(path.join(src, "embed.mjs")).href);
const D = await import(pathToFileURL(path.join(src, "docindex.mjs")).href);
const { openApp } = await import(pathToFileURL(path.join(here, "pagekit.mjs")).href);
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const fails = (p) => p.then(() => "", (e) => String(e.message || e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stand-in OmniRoute
const SYN = { car: "vehicle", cars: "vehicle", automobile: "vehicle", automobiles: "vehicle", vehicle: "vehicle", vehicles: "vehicle", drive: "vehicle", flat: "apartment", apartment: "apartment", lease: "rent", rental: "rent", rent: "rent", tenancy: "rent", doctor: "medical", physician: "medical", clinic: "medical", medical: "medical", puppy: "pet", dog: "pet", pet: "pet" };
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "about", "into", "your", "has", "had", "are", "was", "line", "txt", "docx"]);
const DIM = 512;
const vec = (t) => { const v = new Array(DIM).fill(0); for (const w of String(t).toLowerCase().match(/[a-z]+/g) || []) { if (w.length < 3 || STOP.has(w)) continue; const h = crypto.createHash("md5").update(SYN[w] || w).digest(); v[h.readUInt16BE(0) % DIM] += h[2] & 1 ? 1 : -1; } v[DIM - 1] += 0.01; return v; };
const S = { mode: "ok", calls: 0, inputs: [], auth: "", model: "", noEmbed: false };
const reset = () => { S.calls = 0; S.inputs = []; };
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", async () => {
    const j = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/v1/models") return j({ data: [{ id: "groq/llama-3.3-70b" }, ...(S.noEmbed ? [] : [{ id: "openai/text-embedding-3-small" }, { id: "gemini/gemini-embedding-001" }])] });
    if (req.url === "/v1/embeddings" && req.method === "GET") return S.noEmbed ? j({ data: [] }) : j({ data: [{ id: "mistral/mistral-embed" }] });
    if (req.url === "/v1/embeddings") {
      const b = JSON.parse(body); S.calls++; S.inputs.push(...b.input); S.auth = req.headers.authorization || ""; S.model = b.model;
      if (S.mode === "slow") await sleep(5000);
      if (S.mode === "fail") return j({ error: { message: "quota exceeded" } }, 500);
      return j({ object: "list", data: b.input.map((t, i) => ({ object: "embedding", index: i, embedding: vec(t) })), model: b.model });
    }
    j({ error: { message: "not found" } }, 404);
  });
});
await new Promise((ok) => mock.listen(0, "127.0.0.1", ok));
const MOCK = "http://127.0.0.1:" + mock.address().port;
tools.setOmniRoute(MOCK, () => "test-key");
const KV = path.join(process.env.LOCALAPPDATA, "OmniRouteChat", "kv");
const setKV = (o) => { fs.mkdirSync(KV, { recursive: true }); fs.writeFileSync(path.join(KV, "orc.settings.json"), JSON.stringify(o)); };

const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-meaning-test-" + process.pid);
const O = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-meaning-outside-"));
const f = (...p) => path.join(W, ...p);
const cfg = { ...tools.loadConfig(), cwd: W, roots: [W], granted: [] };
const search = (i, c = cfg) => tools.run("search_meaning", i, c);
let app;
try {
  // ---- embeddings, the automatic model choice and the cache
  const ids = await E.embedModels(true);
  check("Automatic picks an embedding model, free providers first", ids[0] === "gemini/gemini-embedding-001" && ids.includes("mistral/mistral-embed") && ids.includes("openai/text-embedding-3-small") && !ids.includes("groq/llama-3.3-70b"), ids.join(", "));
  const mems = ["Drives a vintage automobile", "Allergic to peanuts", "Plays the cello on weekends"];
  let r = await E.similar("my car makes a strange noise", mems);
  check("similar ranks by meaning: car matches automobile", r.model === "gemini/gemini-embedding-001" && r.scores[0] >= r.cut && r.scores[1] < r.cut && r.scores[2] < r.cut, JSON.stringify(r));
  check("embeddings go to OmniRoute with the key", S.auth === "Bearer test-key" && S.model === "gemini/gemini-embedding-001");
  reset(); await E.similar("my car makes a strange noise", mems);
  check("the same texts again make no embedding call", S.calls === 0, S.calls + " calls");
  E.dropCache();
  check("the cache is on disk", fs.existsSync(path.join(process.env.LOCALAPPDATA, "OmniRouteChat", "embed-cache.json")));
  reset(); r = await E.similar("my car makes a strange noise", mems);
  check("after a restart the disk cache answers (no embedding call)", S.calls === 0 && r.scores[0] >= r.cut, S.calls + " calls");
  reset(); await E.embed(Array.from({ length: 70 }, (_, k) => "batch text number " + k));
  check("texts are sent in batches of at most 32", S.calls === 3 && S.inputs.length === 70, `${S.calls} calls for ${S.inputs.length} texts`);
  reset(); await E.embed(["one specific model"], { model: "openai/text-embedding-3-small" });
  check("a chosen model is used as given", S.model === "openai/text-embedding-3-small");
  check("Off refuses with a plain message", /turned off/.test(await fails(E.embed(["x"], { model: "off" }))));
  S.mode = "fail"; const err = await fails(E.embed(["a text that is not cached yet"]));
  check("an OmniRoute error is reported clearly", /Embedding model .* failed: quota exceeded/.test(err), err); S.mode = "ok";
  S.noEmbed = true; const none = await fails(E.embedModels(true));
  check("no embedding model: says how to add one", /no embedding model/i.test(none) && /Ollama/.test(none), none.slice(0, 120)); S.noEmbed = false; await E.embedModels(true);

  // ---- search_meaning over files
  fs.mkdirSync(f("notes"), { recursive: true }); fs.mkdirSync(f("AppData"), { recursive: true }); fs.mkdirSync(f(".ssh"), { recursive: true }); fs.mkdirSync(f("node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(f("notes", "a.txt"), "Tenancy agreement for the flat on Elm Street. The monthly payment is due on the first day of each month.");
  fs.writeFileSync(f("b.md"), "Service history: the automobile got new brakes and an oil change in March.");
  fs.writeFileSync(f("c.txt"), "Banana bread recipe with walnuts and cinnamon.");
  await tools.run("make_document", { path: f("visit.docx"), title: "Clinic visit", content: "# Clinic visit\n\nThe physician recommended more sleep and a short walk every day." }, cfg);
  fs.writeFileSync(f("AppData", "x.txt"), "APPDATAMARK vehicle automobile car");
  fs.writeFileSync(f(".ssh", "notes.txt"), "SSHMARK vehicle automobile car");
  fs.writeFileSync(f("passwords.txt"), "PWMARK vehicle automobile car");
  fs.writeFileSync(f("credentials.txt"), "CREDMARK vehicle automobile car");
  fs.writeFileSync(f("node_modules", "pkg", "readme.md"), "NODEMARK vehicle automobile car");
  fs.writeFileSync(f("big.txt"), ""); fs.truncateSync(f("big.txt"), 21 * 1024 * 1024);
  fs.writeFileSync(path.join(O, "outside.txt"), "OUTSIDEMARK vehicle automobile car");
  const leaked = () => S.inputs.filter((t) => /APPDATAMARK|SSHMARK|PWMARK|CREDMARK|NODEMARK|OUTSIDEMARK/.test(t));

  setKV({ docMeaning: false });
  let e = await fails(tools.precheck("search_meaning", { query: "apartment lease" }, cfg));
  check("search_meaning is refused while the setting is off, and says where to turn it on", /turned off/.test(e) && /Settings > Search by meaning/.test(e) && /ask the user/i.test(e), e.slice(0, 90));
  check("nothing was indexed while it was off", (await fails(search({ query: "apartment lease" }))) && D.indexInfo().chunks === 0);
  setKV({ docMeaning: true });
  check("a folder outside the allowed folders is refused", /outside the allowed folders/.test(await fails(tools.precheck("search_meaning", { query: "car", path: O }, cfg))));
  check("unknown file types are refused", /cannot be searched by meaning/.test(await fails(tools.precheck("search_meaning", { query: "car", types: ["exe"] }, cfg))));
  const sum = (await tools.precheck("search_meaning", { query: "apartment lease" }, cfg));
  check("search_meaning is a read-only action", sum.class === "read" && /by meaning/.test(sum.summary), JSON.stringify(sum));

  reset(); let out = await search({ query: "apartment lease" });
  const first = (o) => (/^1\. (.+?) \(/m.exec(o) || [])[1] || "";
  check("finds the tenancy agreement for 'apartment lease' (no shared words)", first(out) === f("notes", "a.txt") && /untrusted data/.test(out) && /line 1/.test(out), out.split("\n").slice(0, 3).join(" / "));
  check("Word documents are read and indexed", /visit\.docx/.test(out) && S.inputs.some((t) => /physician/.test(t)));
  check("protected folders, hidden and tool folders, credential files and files outside are never read", leaked().length === 0, leaked().join("; ").slice(0, 120));
  check("files over 20 MB and credential-like names are left out (and said so)", /over 20 MB/.test(out) && /credential-like/.test(out), out.split("\n").slice(-3).join(" / "));
  const info1 = D.indexInfo();
  check("the index knows its files and passages", info1.files === 4 && info1.chunks >= 4 && info1.model === "gemini/gemini-embedding-001", JSON.stringify(info1));

  reset(); out = await search({ query: "car repairs" });
  check("a second search reads no unchanged file (only the new question is embedded)", S.inputs.length === 1 && S.inputs[0] === "car repairs" && first(out) === f("b.md"), `${S.inputs.length} texts: ${S.inputs.join(" | ").slice(0, 100)}`);
  reset(); await search({ query: "car repairs" });
  check("the same search again makes no embedding call at all", S.calls === 0, S.calls + " calls");
  fs.writeFileSync(f("c.txt"), "Gingerbread cookies recipe, baked at 180 degrees."); const t = new Date(Date.now() + 5000); fs.utimesSync(f("c.txt"), t, t);
  reset(); out = await search({ query: "car repairs" });
  check("a changed file is the only one read again", S.inputs.length === 1 && /Gingerbread/.test(S.inputs[0]) && /1 new or changed file was read/.test(out), `${S.inputs.length} texts: ${S.inputs.join(" | ").slice(0, 120)}`);
  fs.unlinkSync(f("b.md"));
  out = await search({ query: "car repairs" });
  check("a deleted file leaves the index", !/b\.md/.test(out) && D.indexInfo().files === 3, `files=${D.indexInfo().files}`);

  out = await search({ query: "car repairs" }, { ...cfg, roots: [f("notes")] });
  check("results stay inside the allowed folders of the call", !/visit\.docx|c\.txt/.test(out) && /notes/.test(first(out)), first(out));
  out = await search({ query: "doctor", path: f("visit.docx") });
  check("path limits the search to one file", first(out) === f("visit.docx") && !/a\.txt/.test(out), first(out));
  out = await search({ query: "doctor", types: ["txt"] });
  check("types limits the search to those formats", !/visit\.docx/.test(out), first(out));

  for (const k of [1, 2, 3]) fs.writeFileSync(f("notes", `new${k}.txt`), `Puppy training diary, week ${k}: the dog learned to sit.`);
  process.env.OMNIGPT_INDEX_BUDGET_MS = "0"; reset(); out = await search({ query: "pet care" });
  check("over the time budget: says indexing continues next time", /Indexing continues next time: 2 files are not read yet/.test(out), out.split("\n").slice(-3).join(" / "));
  delete process.env.OMNIGPT_INDEX_BUDGET_MS; reset(); out = await search({ query: "pet care" });
  check("the next search reads the rest", S.inputs.length === 2 && /new\d\.txt/.test(first(out)), `${S.inputs.length} texts`);

  setKV({ docMeaning: true, embedModel: "openai/text-embedding-3-small" }); reset(); out = await search({ query: "pet care" });
  check("another embedding model starts the index again", /index was started again/.test(out) && S.model === "openai/text-embedding-3-small" && D.indexInfo().model === "openai/text-embedding-3-small", out.split("\n").slice(-2).join(" / "));
  setKV({ docMeaning: true });
  check("Clear index empties it", D.clearIndex().chunks === 0 && !fs.existsSync(path.join(process.env.LOCALAPPDATA, "OmniRouteChat", "index", "meta.json")));
  S.mode = "fail"; e = await fails(search({ query: "pet care" })); S.mode = "ok";
  check("an embedding failure with an empty index is a clear error", /quota exceeded/.test(e), e.slice(0, 100));

  // ---- the page: memories, skills, recall and search_meaning, with the real backend pointed at the stand-in
  app = await openApp({ port: "20231", env: { OMNIROUTE_URL: MOCK } });
  const P = (js, ms) => app.evaluate(js, ms);
  await P(`(() => { window.FAKE = { calls: [], queues: { main: [] }, n: 0 };
    stream = async (a, ui, noThink, out) => {
      if (/You review ONE action/.test(a.system || "")) return '{"verdict":"safe","risk":"low","reason":"ordinary work"}';
      FAKE.calls.push({ messages: JSON.parse(JSON.stringify(a.messages || [])) });
      const r = FAKE.queues.main.shift() || { text: "(script ran out)" };
      if (out) { out.content = [...(r.text ? [{ type: "text", text: r.text }] : []), ...(r.tools || []).map((t) => ({ type: "tool_use", id: "tu" + (++FAKE.n), name: t.name, input: t.input }))]; out.stop = r.tools && r.tools.length ? "tool_use" : "end_turn"; }
      return r.text || "";
    };
    window.results = () => FAKE.calls.map((c) => c.messages[c.messages.length - 1]).filter((m) => m && Array.isArray(m.content)).map((m) => m.content.filter((b) => b.type === "tool_result").map((b) => (b.is_error ? "ERR " : "") + (typeof b.content === "string" ? b.content : JSON.stringify(b.content))).join(" | "));
    window.runTurn = async (q, steps) => { FAKE.calls = []; FAKE.queues.main = steps; ctrl = new AbortController(); busy = true; DELEGATES = 0;
      TURN = { id: uid(), untrusted: false, tok: 0, ok: 0, fail: 0, written: [], t0: Date.now() }; trace = mkTrace();
      try { await agent(q, [{ role: "user", content: q }], ["fake/main-model"]); return results(); } finally { trace.finish(); busy = false; ctrl = null; } };
    LS.set("orc.memories", [{ id: "m1", text: "Name is Ada", kind: "user", ts: 1 }, { id: "m2", text: "Drives a vintage automobile", kind: "fact", ts: 1 }, { id: "m3", text: "Allergic to peanuts", kind: "fact", ts: 1 }, { id: "m4", text: "Plays the cello on weekends", kind: "fact", ts: 1 }]);
    LS.set("orc.skills", [{ id: "k1", name: "Vehicle care", slug: "vehicle-care", description: "Service schedule and repairs for automobiles", instructions: "CHECK THE SERVICE BOOK", on: true }, { id: "k2", name: "Baking", slug: "baking", description: "Bread and cake recipes", instructions: "PREHEAT THE OVEN", on: true }]);
    return true; })()`);
  const Q = "my car makes a strange noise";
  const ctxOf = async (q) => P(`(async () => { SEM.clear(); const t0 = Date.now(); await prepMeaning(${JSON.stringify(q)}); const ms = Date.now() - t0; return { ms, out: userCtx(${JSON.stringify(q)}), used: MEM_USED }; })()`);
  let c = await ctxOf(Q);
  check("page: memories are picked by meaning (car -> automobile), profile facts always", /vintage automobile/.test(c.out) && /Name is Ada/.test(c.out) && !/peanuts|cello/.test(c.out) && c.used.join() === "m1,m2", c.used.join());
  check("page: a skill is picked by meaning", /Skills that apply[\s\S]*CHECK THE SERVICE BOOK/.test(c.out) && !/PREHEAT/.test(c.out) && /Other skills[^\n]*Baking/.test(c.out));
  reset(); c = await ctxOf(Q);
  check("page: asking again makes no embedding call (cached)", S.calls === 0 && /vintage automobile/.test(c.out), S.calls + " calls");
  await P(`setSet("embedModel","off")`); c = await ctxOf(Q);
  check("page: with embeddings Off, word overlap is used (and misses the synonym)", !/vintage automobile/.test(c.out) && /Name is Ada/.test(c.out));
  let rr = await P(`runTurn("what do I drive", [{ tools: [{ name: "recall", input: { query: "car" } }] }, { text: "ok" }])`);
  check("page: recall with embeddings Off matches words only", /No matching memories/.test(rr[0]), rr[0]);
  await P(`setSet("embedModel","auto")`);
  rr = await P(`runTurn("what do I drive", [{ tools: [{ name: "recall", input: { query: "car" } }] }, { text: "ok" }])`);
  check("page: recall finds memories by meaning", /m2  \[fact\] Drives a vintage automobile/.test(rr[0]) && !/peanuts/.test(rr[0]), rr[0]);
  S.mode = "fail"; c = await ctxOf("is there anything with peanuts in this");
  check("page: when embeddings fail, word overlap is used without delay", /Allergic to peanuts/.test(c.out) && c.ms < 1500, c.ms + " ms");
  S.mode = "slow"; await P("SEM_DOWN=0"); c = await ctxOf("tell me something new about my car insurance");
  check("page: a slow embedding model never holds a prompt up more than ~1.5 s", c.ms < 2300 && /Name is Ada/.test(c.out), c.ms + " ms");
  S.mode = "ok"; await P("SEM_DOWN=0"); await sleep(4000);

  const W2 = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-meaning-page-" + process.pid);
  fs.mkdirSync(W2, { recursive: true }); fs.writeFileSync(path.join(W2, "a.txt"), "Tenancy agreement for the flat on Elm Street.");
  rr = await P(`runTurn("find my lease", [{ tools: [{ name: "search_meaning", input: { query: "apartment lease", path: ${JSON.stringify(W2)} } }] }, { text: "ok" }])`);
  check("page: search_meaning is refused until the user turns it on", /^ERR .*Search my documents by meaning/.test(rr[0]), rr[0].slice(0, 120));
  await P(`(async () => { setSet("docMeaning", true); await flushKV(); return true; })()`);
  rr = await P(`runTurn("find my lease", [{ tools: [{ name: "search_meaning", input: { query: "apartment lease", path: ${JSON.stringify(W2)} } }] }, { text: "ok" }])`);
  check("page: once on, search_meaning finds the document", rr[0].includes(path.join(W2, "a.txt")) && /untrusted/.test(rr[0]), rr[0].slice(0, 160));
  const pane = await P(`(async () => { showPane("meaning"); for (let i = 0; i < 40 && !/passages/.test($("#idx-info").textContent); i++) await new Promise((r) => setTimeout(r, 100));
    return { html: $("#s-body").innerHTML, idx: $("#idx-info").textContent, opts: [...$("#emb-model").options].map((o) => o.value), on: $('[data-k="docMeaning"]').checked }; })()`);
  check("page: Settings shows the model choice, the opt-in, the index size and Clear index", /Search my documents by meaning/.test(pane.html) && /a provider on this PC/.test(pane.html) && /Clear index/.test(pane.html) && /1 file, 1 passages/.test(pane.idx) && pane.opts.join() === "auto,off,gemini/gemini-embedding-001,mistral/mistral-embed,openai/text-embedding-3-small" && pane.on, pane.idx + " | " + pane.opts.join());
  const cleared = await P(`api("/api/meaning/clear", {})`);
  check("page: Clear index empties it", cleared.ok && cleared.index.chunks === 0);
  const nav = fs.readFileSync(path.join(src, "index.html"), "utf8");
  check("Settings has a Search by meaning pane", /data-p="meaning">Search by meaning</.test(nav));
  check("no page errors", !app.logs.length, app.logs.join("; ").slice(0, 200));
  fs.rmSync(W2, { recursive: true, force: true });
} catch (e) { check("meaning test", false, String(e.stack || e)); }
if (app) await app.close();
mock.close();
for (const d of [W, O, process.env.LOCALAPPDATA]) fs.rmSync(d, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed.` : "All search-by-meaning checks passed.");
process.exit(failed ? 1 : 0);
