// Built with Claude (Anthropic) - see CREDITS.md
// The agent's tool loop, in the real page with a fake model: old tool output shrinks and read_output brings the rest back,
// read-only actions run side by side, one safety review covers a whole step (verdicts are remembered, and in "ask" mode the
// approval shows while the review runs), and moderate or hard work is checked once before it is called done.
// Run: node loop-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openApp } from "./pagekit.mjs";

let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + String(extra).replace(/\n/g, "\\n").slice(0, 400) : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-loop-test-" + process.pid);
const Wj = J(W);

// Installed in the page: the fake model. The main agent and helpers answer from their own scripts; the safety reviewer (one action or
// a batch), and the self-check answer as the test sets them. Every call is recorded with its time and size.
const FAKE = `(() => {
  window.FAKE = { calls: [], queues: { main: [], helper: [] }, n: 0, revDelay: 0, revOne: null, batch: null, check: [] };
  const who = (s) => /You review ONE action/.test(s) ? "reviewer" : /You review SEVERAL actions/.test(s) ? "batch" : /You check an AI agent's finished work/.test(s) ? "check" : /YOU ARE A HELPER AGENT/.test(s) ? "helper" : "main";
  stream = async (a, ui, noThink, out) => {
    const w = who(String(a.system || "")), c = { who: w, t: Date.now(), tools: (a.tools || []).map((t) => t.name), messages: JSON.parse(JSON.stringify(a.messages || [])), size: JSON.stringify(a.messages || []).length };
    FAKE.calls.push(c);
    if (w === "reviewer" || w === "batch") {
      if (FAKE.revDelay) await new Promise((r) => setTimeout(r, FAKE.revDelay));
      c.done = Date.now();
      const msg = String(a.messages[0].content);
      if (w === "reviewer") return FAKE.revOne ? FAKE.revOne(msg) : '{"verdict":"safe","risk":"low","reason":"ordinary work"}';
      const n = (msg.match(/^### Action \\d+/gm) || []).length;
      return FAKE.batch ? FAKE.batch(n, msg) : JSON.stringify({ verdicts: Array.from({ length: n }, (_, k) => ({ n: k + 1, verdict: "safe", risk: "low", reason: "ordinary work" })) });
    }
    if (w === "check") { c.msg = String(a.messages[0].content); return FAKE.check.shift() || "PASS"; }
    const r = FAKE.queues[w].shift() || { text: "(script ran out)" };
    if (out) { out.content = [...(r.text ? [{ type: "text", text: r.text }] : []), ...(r.tools || []).map((t) => ({ type: "tool_use", id: "tu" + (++FAKE.n), name: t.name, input: t.input }))]; out.stop = r.tools && r.tools.length ? "tool_use" : "end_turn"; }
    if (ui && r.text) ui.text(r.text);
    return r.text || "";
  };
  window.of = (w) => FAKE.calls.filter((c) => c.who === w);
  // the tool results each call of one agent was sent, oldest first: [call][message][block] as text
  window.sent = (w, k) => of(w)[k].messages.filter((m) => m.role === "user" && Array.isArray(m.content)).map((m) => m.content.filter((b) => b.type === "tool_result").map((b) => typeof b.content === "string" ? b.content : b.content.map((x) => x.text || "[" + x.type + "]").join("")));
  window.results = (w) => of(w).map((c) => c.messages[c.messages.length - 1]).filter((m) => m && Array.isArray(m.content))
    .map((m) => m.content.filter((b) => b.type === "tool_result").map((b) => (b.is_error ? "ERR " : "") + (typeof b.content === "string" ? b.content : JSON.stringify(b.content))));
  // every /api/run call: tool, start and end time; SLOW delays chosen tools so overlapping runs can be seen
  window.RUNLOG = []; window.SLOW = {};
  const f0 = window.fetch;
  window.fetch = async (u, o) => {
    if (!String(u).includes("/api/run") || !o || !o.body) return f0(u, o);
    const b = JSON.parse(o.body), e = { name: b.name, path: b.input && b.input.path, t0: Date.now() }; RUNLOG.push(e);
    if (SLOW[b.name]) await new Promise((r) => setTimeout(r, SLOW[b.name]));
    const r = await f0(u, o); e.t1 = Date.now(); return r;
  };
  // one request, as send() starts it, without the router; task: fields for TASK (cx, criteria) or null
  window.runTurn = async (q, steps, helper = [], task = null) => {
    FAKE.calls = []; FAKE.queues.main = steps; FAKE.queues.helper = helper; RUNLOG = [];
    ctrl = new AbortController(); busy = true; DELEGATES = 0;
    TURN = { id: uid(), untrusted: false, tok: 0, ok: 0, fail: 0, written: [], t0: Date.now() };
    TASK = task ? { request: q, plan: "", criteria: [], tests: "", decisions: [], ...task } : null; trace = mkTrace();
    try { return await agent(q, [{ role: "user", content: q }], ["fake/main-model"]); }
    finally { trace.finish(); busy = false; ctrl = null; }
  };
  window.start = (...a) => { window.__done = false; window.__res = null; runTurn(...a).then((r) => { __res = r; __done = true; }, (e) => { __res = "ERROR " + e; __done = true; }); return true; };
  window.mode = async (m) => (await api("/api/config", { approval: m })).approval;
  window.meta = () => { const c = [...document.querySelectorAll(".tooltn")].pop(); return c ? c.querySelector(".who i").textContent : ""; };
  window.btn = () => { const b = document.querySelector(".act button[data-a=y]"); return b ? b.textContent : ""; };
  window.click = (a) => { const b = document.querySelector(".act button[data-a=" + a + "]"); if (!b) return false; b.click(); return true; };
  return true;
})()`;

let app;
try {
  fs.mkdirSync(W, { recursive: true });
  // numbered lines, so every slice of a file is unique
  const bigText = (k) => Array.from({ length: 1500 }, (_, i) => "f" + k + " line " + String(i).padStart(4, "0")).join("\n") + "\nEND-OF-FILE-" + k;
  for (let k = 0; k < 10; k++) fs.writeFileSync(path.join(W, "big" + k + ".txt"), bigText(k));
  for (let k = 0; k < 4; k++) fs.writeFileSync(path.join(W, "s" + k + ".txt"), "small file " + k);
  const big0 = bigText(0);
  app = await openApp({ port: "20211" });
  const E = (js, ms) => app.evaluate(js, ms);
  const until = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await E(js); if (v) return v; await sleep(30); } return null; };
  check("the page loads against a fresh backend", await E(FAKE));
  const P = (n) => J(path.join(W, n));

  // ---- 1. old tool output shrinks; read_output returns the rest
  let final = await E(`runTurn("Read my two big files", [
    { text: "Reading.", tools: [{ name: "read_file", input: { path: ${P("big0.txt")} } }] },
    { tools: [{ name: "read_file", input: { path: ${P("big1.txt")} } }] },
    { tools: [{ name: "read_output", input: { id: 1, offset: 9000 } }] },
    { tools: [{ name: "read_output", input: { id: "#1", offset: 18000 } }] },
    { tools: [{ name: "read_output", input: { id: 99 } }] },
    { text: "Done." }])`);
  let s1 = await E(`sent("main", 1)`), s2 = await E(`sent("main", 2)`), s4 = await E(`sent("main", 4)`), R = await E(`results("main")`);
  check("an output over 9000 characters is cut, and the full text is saved", s1[0][0].startsWith('<tool_output untrusted="true">\n' + big0.slice(0, 9000)) && s1[0][0].includes(`[cut at 9000 of ${big0.length} characters; full output saved as #1; read the rest with read_output]`), s1[0][0].slice(-140));
  check("the newest step's result reaches the model whole", s2[1][0].length > 9000 && s2[1][0].includes("full output saved as #2;"), String(s2[1][0].length));
  check("an older long result shrinks to its start, keeping its number", s2[0][0].length < 800 && s2[0][0].startsWith('<tool_output untrusted="true">\n' + big0.slice(0, 600)) && s2[0][0].includes(`${big0.length} characters in all; full output saved as #1; read the rest with read_output]`) && s2[0][0].endsWith("</tool_output>"), s2[0][0].length + " " + s2[0][0].slice(-130));
  const inner2 = (R[2][0] || "").replace(/^<tool_output untrusted="true">\n\[[^\]]*\]\n/, "").replace(/\n<\/tool_output>$/, "");
  check("read_output returns the next 9000 characters exactly", /^<tool_output untrusted="true">\n\[output #1, characters 9000 to 18000 of \d+; continue with offset 18000\]/.test(R[2][0]) && inner2 === big0.slice(9000, 18000), (R[2][0] || "").slice(0, 120));
  check("read_output reaches the end of the file (id as \"#1\" works too)", /characters 18000 to \d+ of \d+; this is the end\]/.test(R[3][0]) && R[3][0].includes("END-OF-FILE-0"), (R[3][0] || "").slice(0, 100));
  check("an unknown output number is an error", /^ERR Error: there is no saved output #99/.test(R[4][0] || ""), R[4][0]);
  check("a shrunk read_output result points back to the same saved output", s4[2][0].length < 800 && s4[2][0].includes("full output saved as #1;"), s4[2][0].slice(-120));
  check("the agent finishes normally", /^Done\.[\s\S]*\[Actions this turn: read_file, read_file, read_output, read_output, read_output \(not done\)\]$/.test(final), final.slice(-120));
  // pictures still become a note after one viewing, and the picture's text part shrinks like any other output
  const pic = await E(`(() => { TURN = { id: "x", outs: null }; const big = '<tool_output untrusted="true">\\n' + "p".repeat(5000) + '\\n</tool_output>';
    const m = [{ role: "user", content: "q" }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: big }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: big }, { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } }] }] }];
    seenPictures(m); const n = shrinkOld(m); return { n, len: big.length, old: m[1].content[0].content.map((x) => x.type + ":" + (x.text || "").length), oldNote: m[1].content[0].content[1].text, newest: m[3].content[0].content.map((x) => x.type + ":" + (x.text || "").length) }; })()`);
  check("pictures seen once become a note; the newest result keeps its picture", pic.oldNote === "[picture already shown to you above]" && J(pic.newest) === J(["text:" + pic.len, "image:0"]), J(pic));
  check("the text beside an old picture shrinks too", pic.n === 1 && /^text:\d{3}$/.test(pic.old[0]), J(pic.old));
  // a helper without read_output in its tools gets it as soon as it has saved output to read
  await E(`runTurn("delegate", [{ tools: [{ name: "delegate", input: { title: "Read", instructions: "Read big2.txt", tools: "read" } }] }, { text: "ok" }],
    [{ tools: [{ name: "read_file", input: { path: ${P("big2.txt")} } }] }, { text: "REPORT read it" }])`);
  const ht = await E(`of("helper").map((c) => c.tools.includes("read_output"))`);
  check("a helper is given read_output once its output was cut", J(ht) === J([false, true]), J(ht));

  // ---- 2. characters sent per model call, 10 steps with big outputs, before and after shrinking
  const tenSteps = J([...Array.from({ length: 10 }, (_, k) => ({ tools: [{ name: "read_file", input: { path: path.join(W, "big" + k + ".txt") } }] })), { text: "Read them all." }]);
  await E(`SHRINK_AT = Infinity`); await E(`runTurn("read ten files", ${tenSteps})`);
  const before = await E(`of("main").map((c) => c.size)`);
  await E(`SHRINK_AT = 1500`); await E(`runTurn("read ten files", ${tenSteps})`);
  const after = await E(`of("main").map((c) => c.size)`);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  console.log(`      characters sent per model call (11 calls): before ${J(before)} = ${sum(before)} in all; after ${J(after)} = ${sum(after)} in all`);
  check("over 10 steps with big outputs, far fewer characters are sent", after.length === 11 && sum(after) < sum(before) * 0.35 && after[10] < before[10] * 0.3, `before ${sum(before)}, after ${sum(after)}; last call ${before[10]} -> ${after[10]}`);

  // ---- 3. read-only actions at the same time
  await E(`SLOW = { read_file: 700 }; true`);
  let t0 = Date.now();
  await E(`runTurn("read four small files", [{ text: "Reading all four.", tools: [0, 1, 2, 3].map((k) => ({ name: "read_file", input: { path: ${Wj} + "/s" + k + ".txt" } })) }, { text: "All read." }])`);
  const gap = await E(`(() => { const m = of("main"); return m[1].t - m[0].t; })()`);
  R = await E(`results("main")`);
  check("four reads in one step finish in about the time of one (700 ms each)", gap < 1500, gap + " ms (one at a time would be over 2800 ms)");
  check("their results come back in the original order", J((R[0] || []).map((t) => /small file (\d)/.exec(t)?.[1])) === J(["0", "1", "2", "3"]), J(R[0]).slice(0, 200));
  check("one reviewer call covers the four reads", (await E(`of("batch").length`)) === 1 && (await E(`of("reviewer").length`)) === 0);
  check("the counters count every action", (await E(`TURN.ok`)) === 4);
  // a change in between keeps its place: read, write, then the two later reads together
  check("auto mode for the next checks", (await E(`mode("auto")`)) === "auto");
  await E(`SLOW = { read_file: 500, write_file: 500 }; true`);
  final = await E(`runTurn("read, write, read", [{ tools: [{ name: "read_file", input: { path: ${P("s0.txt")} } }, { name: "write_file", input: { path: ${P("w.txt")}, content: "written" } },
    { name: "read_file", input: { path: ${P("s1.txt")} } }, { name: "read_file", input: { path: ${P("s2.txt")} } }] }, { text: "ok" }])`);
  const log = await E(`RUNLOG`), [ra, wr, rb, rc] = log;
  const order = log.length === 4 && wr.name === "write_file" && ra.t1 <= wr.t0 && wr.t1 <= rb.t0 && wr.t1 <= rc.t0 && Math.abs(rb.t0 - rc.t0) < 200;
  check("a writing action waits for the reads before it, and the reads after it wait for it", order, J(log.map((e) => [e.name, (e.path || "").split(/[\\/]/).pop(), e.t0 - log[0].t0, e.t1 - log[0].t0])));
  const cards = await E(`[...[...document.querySelectorAll(".trace")].pop().querySelectorAll(".tooltn .who span")].map((s) => s.textContent.replace("Action · ", ""))`);
  check("the action cards appear in the model's order", J(cards) === J(["read_file", "write_file", "read_file", "read_file"]), J(cards));
  check("the actions list keeps the model's order", /\[Actions this turn: read_file, write_file, read_file, read_file\]$/.test(final) && fs.readFileSync(path.join(W, "w.txt"), "utf8") === "written", final.slice(-80));
  await E(`SLOW = {}; true`);

  // ---- 4. safety reviews
  const write3 = (tag) => J([{ tools: [1, 2, 3].map((k) => ({ name: "write_file", input: { path: path.join(W, tag + k + ".txt"), content: tag + " " + k } })) }, { text: "Wrote three." }]);
  await E(`runTurn("write three files", ${write3("a")})`);
  let rc1 = await E(`({ batch: of("batch").length, one: of("reviewer").length, msg: of("batch")[0] && of("batch")[0].messages[0].content })`);
  check("one reviewer call for a step with three actions", rc1.batch === 1 && rc1.one === 0 && /### Action 3 \(write/.test(rc1.msg || "") && [1, 2, 3].every((k) => fs.existsSync(path.join(W, "a" + k + ".txt"))), J({ batch: rc1.batch, one: rc1.one }));
  await E(`FAKE.batch = () => "They all look fine to me."; true`);
  await E(`runTurn("write three files", ${write3("b")})`);
  rc1 = await E(`({ batch: of("batch").length, one: of("reviewer").length })`);
  check("an unreadable batch answer falls back to one review per action", rc1.batch === 1 && rc1.one === 3 && [1, 2, 3].every((k) => fs.existsSync(path.join(W, "b" + k + ".txt"))), J(rc1));
  await E(`FAKE.batch = (n) => 'Here you go: [{"n":1,"verdict":"safe","risk":"low","reason":"ok"},{"n":3,"verdict":"safe","risk":"low","reason":"ok"}]'; true`);
  await E(`runTurn("write three files", ${write3("c")})`);
  rc1 = await E(`({ batch: of("batch").length, one: of("reviewer").length, oneMsg: of("reviewer")[0] && of("reviewer")[0].messages[0].content })`);
  check("a batch answer missing one verdict reviews only that action again", rc1.batch === 1 && rc1.one === 1 && /c2\.txt/.test(rc1.oneMsg || ""), J({ batch: rc1.batch, one: rc1.one }));
  await E(`FAKE.batch = null; true`);
  // remembered verdicts
  const same = J({ name: "write_file", input: { path: path.join(W, "same.txt"), content: "same" } });
  await E(`runTurn("write the same file twice", [{ tools: [${same}] }, { tools: [${same}] }, { text: "ok" }])`);
  const metas = await E(`[...[...document.querySelectorAll(".trace")].pop().querySelectorAll(".tooltn .who i")].map((i) => i.textContent)`);
  check("an identical action in the same request reuses its verdict", (await E(`of("reviewer").length + of("batch").length`)) === 1 && metas[0] === "write · safe · done" && metas[1] === "write · safe (remembered) · done", J(metas));
  await E(`runTurn("write the same file twice", [{ tools: [${same}] }, { text: "ok" }])`);
  check("a new request reviews it again", (await E(`of("reviewer").length`)) === 1);
  // in auto mode the verdict is still needed before the action runs
  await E(`FAKE.revDelay = 800; true`);
  await E(`runTurn("write one file", [{ tools: [{ name: "write_file", input: { path: ${P("late.txt")}, content: "x" } }] }, { text: "ok" }])`);
  const wait = await E(`({ done: of("reviewer")[0].done, run: RUNLOG[0] && RUNLOG[0].t0 })`);
  check("in auto mode an action runs only after its review", wait.run >= wait.done, J(wait));
  await E(`FAKE.revDelay = 0; true`);
  // size rules: more than 10 files in one action is high risk without asking a model
  await E(`start("write many", [{ tools: [{ name: "write_files", input: { files: Array.from({ length: 11 }, (_, k) => ({ path: ${Wj} + "/m" + k + ".txt", content: "m" })) } }] }, { text: "ok" }])`);
  const big = await until(`btn()`);
  check("an action on 11 files asks the user, without a reviewer call", big === "Run anyway (reviewer objected)" && (await E(`of("reviewer").length + of("batch").length`)) === 0, big);
  await E(`click("n")`); await until(`__done`);
  check("denied, nothing is written", (await E(`results("main")[0][0]`)) === "ERR The user denied this action." && !fs.existsSync(path.join(W, "m0.txt")));
  // ask mode: the approval shows while the review runs, and the verdict joins the card when it arrives
  check("ask mode for the next checks", (await E(`mode("ask")`)) === "ask");
  await E(`FAKE.revDelay = 1500; true`);
  await E(`start("write one file", [{ tools: [{ name: "write_file", input: { path: ${P("e1.txt")}, content: "e1" } }] }, { text: "ok" }])`);
  t0 = Date.now(); const shown = await until(`btn()`), early = await E(`({ pending: of("reviewer").length === 1 && !of("reviewer")[0].done, meta: meta() })`);
  check("in ask mode the approval card appears before the review returns", shown === "Approve" && early.pending && /write · reviewing… · waiting for approval/.test(early.meta), J(early) + " after " + (Date.now() - t0) + " ms");
  await until(`of("reviewer")[0].done`); await sleep(50);
  check("the verdict joins the waiting card when it arrives", /^write · safe · waiting for approval$/.test(await E(`meta()`)), await E(`meta()`));
  await E(`click("y")`); await until(`__done`);
  check("approved after the verdict, the action runs", fs.readFileSync(path.join(W, "e1.txt"), "utf8") === "e1" && /^write · safe · done$/.test(await E(`meta()`)), await E(`meta()`));
  await E(`FAKE.revDelay = 2500; true`);
  await E(`start("write one file", [{ tools: [{ name: "write_file", input: { path: ${P("e2.txt")}, content: "e2" } }] }, { text: "ok" }])`);
  await until(`btn()`); await E(`click("y")`);
  let ranEarly = false; for (let k = 0; k < 60 && !ranEarly; k++) { ranEarly = fs.existsSync(path.join(W, "e2.txt")); if (!ranEarly) await sleep(30); }
  const stillPending = await E(`!of("reviewer")[0].done`);
  check("the user can approve before the review returns, and the action runs at once", ranEarly && stillPending);
  await until(`__done`, 8000); await until(`of("reviewer")[0].done`); await sleep(50);
  check("the late verdict still shows on the card", /^write · safe · done$/.test(await E(`meta()`)), await E(`meta()`));
  await E(`FAKE.revDelay = 800; FAKE.revOne = () => '{"verdict":"unsafe","risk":"high","reason":"outside the request"}'; true`);
  await E(`start("write one file", [{ tools: [{ name: "write_file", input: { path: ${P("e3.txt")}, content: "e3" } }] }, { text: "ok" }])`);
  const b0 = await until(`btn()`); await until(`of("reviewer")[0].done`); await sleep(50); const b1 = await E(`btn()`);
  check("an objection from the reviewer relabels the waiting button", b0 === "Approve" && b1 === "Run anyway (reviewer objected)" && /write · unsafe · waiting/.test(await E(`meta()`)), b0 + " -> " + b1);
  await E(`click("n")`); await until(`__done`);
  check("denied, the file is not written", !fs.existsSync(path.join(W, "e3.txt")));
  await E(`FAKE.revDelay = 0; FAKE.revOne = null; true`);
  // two reads that both need the user's approval run side by side, but their approvals still come one at a time
  await E(`FAKE.batch = (n) => JSON.stringify({ verdicts: Array.from({ length: n }, (_, k) => ({ n: k + 1, verdict: "unsafe", risk: "high", reason: "looks odd" })) }); true`);
  await E(`start("read two", [{ tools: [{ name: "read_file", input: { path: ${P("s0.txt")} } }, { name: "read_file", input: { path: ${P("s1.txt")} } }] }, { text: "ok" }])`);
  const rows = [];
  for (let k = 0; k < 2; k++) { await until(`btn()`); await sleep(150); rows.push(await E(`document.querySelectorAll(".act").length`)); await E(`click("y")`); await sleep(50); }
  await until(`__done`);
  R = await E(`results("main")`);
  check("approvals in a group of reads still come one at a time", J(rows) === J([1, 1]) && /small file 0/.test(R[0][0]) && /small file 1/.test(R[0][1]), J(rows));
  await E(`FAKE.batch = null; true`);

  // ---- 5. the work is checked once before it is called done
  check("auto mode again", (await E(`mode("auto")`)) === "auto");
  const writeStep = (n, c) => ({ tools: [{ name: "write_file", input: { path: path.join(W, n), content: c } }] });
  await E(`runTurn("make notes", ${J([writeStep("n1.txt", "x"), { text: "Done." }])}, [], { cx: "simple" })`);
  check("no self-check for a simple request", (await E(`of("check").length`)) === 0);
  await E(`runTurn("look at notes", [{ tools: [{ name: "read_file", input: { path: ${P("s0.txt")} } }] }, { text: "It says small file 0." }], [], { cx: "moderate" })`);
  check("no self-check when nothing was changed", (await E(`of("check").length`)) === 0);
  final = await E(`runTurn("make notes", ${J([writeStep("n2.txt", "notes"), { text: "Done." }])}, [], { cx: "moderate" })`);
  let ck = await E(`of("check").map((c) => c.msg)`);
  check("a moderate request that changed something is checked once", ck.length === 1 && /^Done\./.test(final) && /3 concrete checks/.test(ck[0]) && /write_file: Create .*n2\.txt \(5 chars\) → /.test(ck[0]) && /The agent's final answer:\nDone\./.test(ck[0]), (ck[0] || "").slice(0, 400));
  check("on PASS the agent's answer is the visible answer", /^Done\./.test(await E(`[...document.querySelectorAll(".turn.final")].pop().querySelector(".body").textContent`)) && (await E(`!![...document.querySelectorAll(".trace")].pop().querySelector(".turn") && [...[...document.querySelectorAll(".trace")].pop().querySelectorAll(".who span")].some((s) => s.textContent === "Self-check")`)));
  // a planted problem: the first pass writes the wrong text, the check says so, one more round fixes it
  await E(`FAKE.check = ["PROBLEMS:\\n1. notes.txt says draft; the criterion needs the word DONE in it."]; true`);
  final = await E(`runTurn("write DONE into notes.txt", ${J([writeStep("notes.txt", "draft"), { text: "Done." }, writeStep("notes.txt", "DONE"), { text: "Fixed: notes.txt now says DONE." }])}, [], { cx: "hard", criteria: ["notes.txt contains the word DONE"] })`);
  ck = await E(`of("check").map((c) => c.msg)`);
  const fb = await E(`(() => { const m = of("main")[2].messages; return m.slice(-2).map((x) => typeof x.content === "string" ? x.content : x.content.map((b) => b.text || b.type).join(" ")); })()`);
  check("the check gets the advisor's criteria", ck.length === 1 && /Acceptance criteria:\n1\. notes\.txt contains the word DONE/.test(ck[0]), (ck[0] || "").slice(0, 200));
  check("the problems go back to the agent for one more round", fb[0] === "Done." && /a check of your work found these problems:\n1\. notes\.txt says draft/.test(fb[1]), J(fb).slice(0, 200));
  check("the extra round fixes the planted problem", /^Fixed: notes\.txt now says DONE\./.test(final) && fs.readFileSync(path.join(W, "notes.txt"), "utf8") === "DONE", final.slice(0, 80));
  const tr = await E(`(() => { const t = [...document.querySelectorAll(".trace")].pop(); return { line: [...t.querySelectorAll(".turn:not(.tooltn)")].map((x) => x.querySelector(".who span").textContent + ": " + x.querySelector(".body").textContent.slice(0, 60)).filter((x) => /^Self-check/.test(x)), fin: [...document.querySelectorAll(".turn.final")].pop().querySelector(".body").textContent }; })()`);
  check("the trace shows what the check found, and the fixed answer is the visible one", tr.line.length === 1 && /Problems found/.test(tr.line[0]) && /^Fixed:/.test(tr.fin), J(tr));
  await E(`FAKE.check = ["PROBLEMS: 1. first", "PROBLEMS: 2. second"]; true`);
  final = await E(`runTurn("write DONE", ${J([writeStep("n3.txt", "a"), { text: "Done." }, writeStep("n3.txt", "b"), { text: "Done again." }])}, [], { cx: "hard" })`);
  check("at most one extra round", (await E(`of("check").length`)) === 1 && /^Done again\./.test(final), final.slice(0, 40));
  // helpers are not checked on their own; their main agent is
  await E(`FAKE.check = []; true`);
  await E(`runTurn("have a helper write h.txt", [{ tools: [{ name: "delegate", input: { title: "Write", instructions: "Write h.txt" } }] }, { text: "The helper wrote it." }],
    [${J(writeStep("h.txt", "h"))}, { text: "REPORT wrote h.txt" }], { cx: "moderate" })`);
  const who = await E(`FAKE.calls.filter((c) => c.who !== "reviewer").map((c) => c.who)`);
  check("a helper's work is not self-checked; the main agent's answer is, once", J(who) === J(["main", "helper", "helper", "main", "check"]), J(who));
  check("no errors in the page", app.logs.length === 0, app.logs.join("; ").slice(0, 300));
} catch (e) { check("loop test", false, String(e.stack || e).slice(0, 600)); }
if (app) await app.close();
fs.rmSync(W, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed.` : "All tool loop checks passed.");
process.exit(failed ? 1 : 0);
