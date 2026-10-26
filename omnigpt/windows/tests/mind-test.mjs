// Built with Claude (Anthropic) - see CREDITS.md
// The "mind" section of the page, in the real page with a fake model: stakes, likely goal and a clarifying question from the router,
// sources under answers, the requirements ledger (kept per chat), what the program knows about the user's work, remembered error fixes,
// "have I answered this before", the pre-mortem, evidence from code for disagreements, per-model habit reminders, learning from
// corrections and undos, and studying failures while idle.
// Run: node mind-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openApp } from "./pagekit.mjs";

let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + String(extra).replace(/\n/g, "\\n").slice(0, 300) : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-mind-test-" + process.pid);
fs.mkdirSync(W, { recursive: true });
fs.writeFileSync(path.join(W, "notes.txt"), "private note");

const FAKE = `(() => {
  window.FAKE = { queue: [], n: 0 };
  stream = async (a, ui, noThink, out) => {
    const s = String(a.system || "");
    if (/You review (ONE action|SEVERAL actions)/.test(s)) { const n = (String(a.messages[0].content).match(/^### Action \\d+/gm) || []).length; return n ? J({ verdicts: Array.from({ length: n }, (_, k) => ({ n: k + 1, verdict: "safe", risk: "low", reason: "ok" })) }) : '{"verdict":"safe","risk":"low","reason":"ok"}'; }
    const r = FAKE.queue.shift() || { text: "done" };
    if (out) { out.content = [...(r.text ? [{ type: "text", text: r.text }] : []), ...(r.tools || []).map((t) => ({ type: "tool_use", id: "tu" + (++FAKE.n), name: t.name, input: t.input }))]; out.stop = r.tools ? "tool_use" : "end_turn"; }
    if (ui && r.text) ui.text(r.text);
    return r.text || "";
  };
  const J = JSON.stringify;
  window.go = (q, steps, criteria, extra) => { FAKE.queue = steps; window.__done = false; window.__res = null; ctrl = new AbortController(); busy = true;
    TURN = { id: uid(), untrusted: false, tok: 0, ok: 0, fail: 0, written: [], t0: Date.now() };
    TASK = { request: q, plan: "", criteria, tests: "", decisions: [], cx: "moderate", ...(extra || {}) }; trace = mkTrace();
    agent(q, [{ role: "user", content: q }], ["fake/main"]).then((r) => { __res = r; }, (e) => { __res = "ERROR " + e; }).finally(() => { trace.finish(); busy = false; ctrl = null; __done = true; }); return true; };
  return true;
})()`;

let app;
try {
  app = await openApp({ port: "20233" });
  const E = (js, ms) => app.evaluate(js, ms);
  const until = async (js, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const x = await E(js); if (x) return x; await sleep(40); } return null; };
  const cfgDir = path.join(app.data, "OmniRouteChat"); fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), J({ approval: "ask", cwd: W, roots: [path.dirname(W)], granted: [W] }));
  check("the page loads with the fake model", await E(FAKE));
  await E(`LS.set("orc.settings", { learn: true, memory: true }); $("#pc").checked = true; true`);

  // ---- 2, 12. the router: stakes, likely goal, a clarifying question
  await E(`FAKE.queue = [{ text: ${J(J({ complexity: "moderate", tools: true, groups: ["files"], stakes: "high", goal: "wants the duplicates gone but the originals safe", ask: "Which folder should I clean?", done_when: ["duplicates are removed"], reason: "x" }))} }]; true`);
  const c1 = await E(`classify("delete my duplicate photos").then(r => ({ stakes: r.stakes, goal: r.goal, ask: r.ask, crit: r.crit }))`);
  check("the router's stakes, likely goal and question come through for deep work", c1 && c1.stakes === "high" && /originals/.test(c1.goal) && /Which folder/.test(c1.ask) && c1.crit.length === 1, J(c1));
  await E(`FAKE.queue = [{ text: ${J(J({ complexity: "simple", tools: false, stakes: "low", goal: "x", ask: "why?", done_when: ["a"], reason: "x" }))} }]; true`);
  const c2 = await E(`classify("what is a closure").then(r => ({ stakes: r.stakes, goal: r.goal, ask: r.ask, crit: r.crit }))`);
  check("a simple low-stakes question gets no goal, question or checklist", c2 && c2.stakes === "low" && !c2.goal && !c2.ask && c2.crit.length === 0, J(c2));
  await E(`FAKE.queue = [{ text: ${J(J({ complexity: "simple", tools: true, stakes: "high", done_when: ["files are gone"], reason: "x" }))} }]; true`);
  check("a simple but high-stakes request still gets a checklist", (await E(`classify("delete old.txt").then(r => r.crit.length)`)) === 1);

  // the check runs for a high-stakes request even if it is only "simple"
  const rd = { tools: [{ name: "read_file", input: { path: path.join(W, "notes.txt") } }] };
  await E(`go("look", [${J(rd)}, { text: "Fine." }, { text: "PASS" }], ["it looked"], { cx: "simple", stakes: "high" })`); await until("__done");
  check("high stakes get the final check even for a simple request", (await E("TASK.verdict")) === "pass");
  await E(`go("look", [${J(rd)}, { text: "Fine." }], ["it looked"], { cx: "simple", stakes: "low" })`); await until("__done");
  check("a simple low-stakes request does not", (await E("TASK.verdict === undefined")) === true);

  // ---- 1. sources under the answer
  await E(`go("read the note", [${J(rd)}, { text: "It says private note." }, { text: "PASS" }], ["it read the note"])`); await until("__done");
  check("the files read are listed under the answer", /Sources: files: notes\.txt/.test(await E(`document.querySelector(".srcs") ? document.querySelector(".srcs").textContent : ""`)));
  await E(`TURN = { id: "x", src: [] }; noteSource({ name: "web_open", input: { url: "https://www.example.com/a/b" } }, { ok: true }); noteSource({ name: "web_search", input: { query: "node lts" } }, { ok: true }); noteSource({ name: "web_open", input: { url: "https://bad.example/" } }, { ok: false }); true`);
  check("pages opened and searches are listed, failures are not", (await E("sourcesLine()")) === "web: example.com, search: node lts", await E("sourcesLine()"));

  // ---- 3. the requirements ledger
  const L = await E(`ledgerFrom("Write a summary. Always use metric units. Make sure it is under one page. What do you think?")`);
  check("rules the user states are picked out, questions are not", L.length === 2 && /metric/.test(L[0]) && /under one page/.test(L[1]), J(L));
  await E(`LEDGER = []; ledgerAdd("Always use metric units."); ledgerAdd("always use metric units please."); ledgerAdd("Never use jargon in the answer."); true`);
  check("the same rule is not kept twice", (await E("LEDGER.length")) === 2);
  check("the ledger joins the context of later prompts", /Requirements the user stated earlier[\s\S]*metric units/.test(await E("mindCtx()")));
  await E(`history = [{ role: "user", content: "q" }, { role: "assistant", content: "a" }]; saveChat("q"); true`);
  await sleep(600);
  check("the ledger is saved with the chat and comes back when it is opened", await E(`(async () => { const c = await chatGet(chatId); LEDGER = []; return Array.isArray(c.ledger) && c.ledger.length === 2 })()`));
  await E(`newChat(); true`);
  check("a new chat starts with an empty ledger", (await E("LEDGER.length")) === 0);

  // ---- 4. what the program knows about the user's work
  await E(`TURN = { id: "w", written: ["C:\\\\Work\\\\report.docx", "C:\\\\Work\\\\a.docx", "C:\\\\Work\\\\data.csv"] }; worldNote(); true`);
  const wl = await E("worldLine()");
  check("recent files and favourite file types are known", /report\.docx/.test(wl) && /\.docx/.test(wl) && /Files made for this user/.test(wl), wl);

  // ---- 5. error -> fix memory
  await E(`LS.set("orc.fixes", []); TURN = { id: "f" };
    fixTrack({ name: "run_command", input: { command: "py x.py" } }, { err: true, text: "Error: 'py' is not recognized (C:\\\\a\\\\b.txt line 12)" });
    fixTrack({ name: "run_command", input: { command: "python x.py" } }, { err: false, text: "ok" }); true`);
  check("an error that was solved is remembered with what worked", (await E(`LS.get("orc.fixes")[0].fix`)) === "python x.py");
  check("the same error (other path and number) comes with the fix next time", /python x\.py/.test(await E(`fixHint({ name: "run_command" }, "Error: 'py' is not recognized (C:\\\\z\\\\q.txt line 99)")`)));
  await E(`TURN = { id: "g" }; for (let i = 0; i < 2; i++) fixTrack({ name: "read_file", input: {} }, { err: true, text: "Error: no such thing at C:\\\\k\\\\x.txt" }); fixFinish(); true`);
  check("an error that was never solved is remembered as such", /never solved/.test(await E(`fixHint({ name: "read_file" }, "Error: no such thing at C:\\\\other\\\\y.txt")`)));
  check("an error nobody has seen gets no hint", (await E(`fixHint({ name: "read_file" }, "Error: something completely new")`)) === "");

  // ---- 6. have I answered this before?
  await E(`LS.set("orc.past", []); TURN = { id: "p" }; pastRecord("How do I convert a docx file to a pdf on Windows?", "Use Word's Save As, or soffice --headless."); true`);
  check("a similar earlier request is found", /soffice/.test(await E(`(pastFind("how can I convert docx to pdf in windows") || {}).a || ""`)));
  check("an unrelated request finds nothing", (await E(`pastFind("what is the capital of australia and its population")`)) === null);
  await E(`TURN = { id: "p2", readLocal: true }; pastRecord("Summarize my private tax documents please", "secret"); TURN = { id: "p3", untrusted: true }; pastRecord("What does that web page say about shipping?", "inject"); true`);
  check("answers built from private files or web pages are not kept", (await E(`PAST().length`)) === 1);

  // ---- 7. pre-mortem
  await E(`FAKE.queue = [{ text: ${J(J({ risks: [{ risk: "wrong folder is cleaned", check: "only the chosen folder changed" }, { risk: "originals lost", check: "every file that had a duplicate still exists once" }] }))} }]; TASK = { criteria: ["a"], decisions: [], cx: "hard" }; premortem("delete duplicates").then(() => { window.__pm = true; }); true`);
  await until("window.__pm === true");
  check("the pre-mortem adds checks to the criteria", (await E("TASK.criteria.length")) === 3 && /only the chosen folder/.test(await E("TASK.criteria[1]")));

  // ---- 8. evidence from code
  if (await E("SBX.available === true")) {
    await E(`FAKE.queue = [{ text: "\`\`\`python\\nprint('2**10 is', 2**10)\\n\`\`\`" }]; true`);
    const ev = await E(`settleByCode("what is 2 to the 10th", ["one draft says 1000, another 1024"])`, 30000);
    check("a disagreement is settled by running code", /Evidence from running code/.test(ev) && /1024/.test(ev), ev);
  } else check("a disagreement is settled by running code (skipped: no sandbox here)", true);
  check("no disagreement means no code is run", (await E(`settleByCode("q", [])`)) === "");

  // ---- 9. per-model habits
  await E(`LS.set("orc.habits", {}); for (let i = 0; i < 4; i++) habit("m/a", "runs"); habit("m/a", "ghost"); habit("m/a", "ghost"); habit("m/b", "runs"); habit("m/b", "ghost"); true`);
  check("a model that often names files it never made is reminded", /Never say a file exists/.test(await E(`habitNote("m/a")`)));
  check("a model with too little history, or no bad habit, is not", (await E(`habitNote("m/b")`)) === "" && (await E(`habitNote("m/c")`)) === "");

  // ---- 10. corrections and undos
  await E(`LS.set("orc.signals", {}); LS.set("orc.episodes", []); history = [{ role: "user", content: "q" }, { role: "assistant", content: "a" }]; TURN = { id: "c" }; TASK = { verdict: "problems", criteria: [], decisions: [] }; mindEnd("no, I meant the other folder", "ok", true); true`);
  check("a correction is counted and kept for study", (await E(`LS.get("orc.signals").corrected`)) === 1 && (await E(`EPI().some(e => e.why === "correction")`)));
  check("a failed final check is kept for study too", await E(`EPI().some(e => e.why === "check")`));
  check("the user's way of saying it was wrong is recognised", await E(`CORRECTION.test("no, I meant the other folder")`));

  // ---- 11. studying while idle
  await E(`LS.set("orc.studyAt", 0); LASTACT = Date.now(); true`);
  check("it does not study while the user is active", (await E("studyDue()")) === false);
  await E(`LASTACT = Date.now() - 11 * 60000; busy = false; true`);
  check("it studies when idle and there is something to learn from", (await E("studyDue()")) === true);
  await E(`LS.set("orc.memories", []); FAKE.queue = [{ text: ${J(J({ rules: ["Ask which folder before moving or deleting files."] }))} }]; true`);
  check("studying turns the episodes into a rule", (await E("study()")) === true && /Ask which folder/.test(await E(`MEM().map(m => m.text).join("|")`)));
  check("studied episodes are marked done and it waits an hour", (await E(`EPI().every(e => e.done)`)) && (await E("studyDue()")) === false);

  // ---- context pieces and the off switch
  await E(`$("#pc").checked = true; TURN = { id: "m", past: { q: "old q", a: "old a" } }; TASK = { goal: "wants it emailable", ask: "Which quarter?", stakes: "high", cx: "hard", criteria: [], decisions: [] }; LEDGER = []; true`);
  const mc = await E("mindCtx()");
  check("goal, question, stakes, earlier answer and the 'say how sure' rule are in the context", /wants it emailable/.test(mc) && /Which quarter/.test(mc) && /HIGH STAKES/.test(mc) && /old q/.test(mc) && /\(unverified\)/.test(mc), mc);
  await E(`LS.set("orc.settings", { learn: true, memory: true, mind: false }); true`);
  check("'mind: false' switches it all off", (await E("mindCtx()")) === "" && (await E(`(TURN.src = [], noteSource({ name: "web_open", input: { url: "https://a.b" } }, { ok: true }), TURN.src.length)`)) === 0);

  check("no page errors", !app.logs.length, app.logs.join("; "));
} catch (e) { check("mind test", false, e.stack || e.message); }
finally { if (app) await app.close(); fs.rmSync(W, { recursive: true, force: true }); }
console.log(failed ? `${failed} check(s) failed.` : "All mind checks passed.");
process.exit(failed ? 1 : 0);
