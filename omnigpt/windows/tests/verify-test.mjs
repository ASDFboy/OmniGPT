// Built with Claude (Anthropic) - see CREDITS.md
// Checking work against reality: (1) the program's own file checks (verifyFile), (2) in the real page with a fake model: the router's
// "done when" statements, a claimed file that does not exist forcing a fix round and an honest note, an existing file passing, and
// the personal test set (recordCase), (3) replay.mjs's pick() and compare().
// Run: node verify-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openApp, src } from "./pagekit.mjs";

let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + String(extra).replace(/\n/g, "\\n").slice(0, 300) : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-verify-test-" + process.pid);
fs.mkdirSync(W, { recursive: true });
const put = (f, d) => fs.writeFileSync(path.join(W, f), d);

let app;
try {
  // ---- 1. the program's own file checks
  const { verifyFile } = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
  const cfg = { cwd: W, roots: [W] };
  put("good.json", '{"a":1}'); put("bad.json", '{"a":'); put("empty.txt", ""); put("ok.js", "const a = 1;\n"); put("bad.js", "const = ;\n");
  put("fake.pdf", "this is not a pdf"); put("real.docx", "PK\u0003\u0004rest"); put("notes.txt", "private note");
  const v = (f) => verifyFile(path.join(W, f), cfg);
  check("a file that is not there is reported", v("missing.md").ok === false && /does not exist/.test(v("missing.md").note));
  check("an empty file is reported", v("empty.txt").ok === false && /empty/.test(v("empty.txt").note));
  check("broken JSON is reported, good JSON passes", v("bad.json").ok === false && v("good.json").ok === true);
  check("a JavaScript syntax error is reported, good code passes", v("bad.js").ok === false && /syntax/.test(v("bad.js").note) && v("ok.js").ok === true);
  check("a .pdf that is not a PDF is reported, a zip-based .docx passes", v("fake.pdf").ok === false && /header/.test(v("fake.pdf").note) && v("real.docx").ok === true);
  check("a path outside the allowed folders is not looked at", verifyFile(path.join(os.homedir(), "Documents"), cfg).checked === false);

  // ---- 2. the real page, with a fake model
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
    window.go = (q, steps, criteria) => { FAKE.queue = steps; window.__done = false; window.__res = null; ctrl = new AbortController(); busy = true;
      TURN = { id: uid(), untrusted: false, tok: 0, ok: 0, fail: 0, written: [], t0: Date.now() };
      TASK = { request: q, plan: "", criteria, tests: "", decisions: [], cx: "moderate" }; trace = mkTrace();
      agent(q, [{ role: "user", content: q }], ["fake/main"]).then((r) => { __res = r; }, (e) => { __res = "ERROR " + e; }).finally(() => { trace.finish(); busy = false; ctrl = null; __done = true; }); return true; };
    return true;
  })()`;
  app = await openApp({ port: "20232" });
  const E = (js, ms) => app.evaluate(js, ms);
  const until = async (js, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const x = await E(js); if (x) return x; await sleep(40); } return null; };
  const cfgDir = path.join(app.data, "OmniRouteChat"); fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), J({ approval: "ask", cwd: W, roots: [path.dirname(W)], granted: [W] }));
  check("the page loads with the fake model", await E(FAKE));

  // the router's "done when" statements: kept (at most 4) for moderate and hard work, dropped for simple questions
  await E(`FAKE.queue = [{ text: ${J(J({ complexity: "moderate", tools: true, groups: [], parallel: false, compute: false, web: false, done_when: ["report.md exists", "it has a section per topic", "a", "b", "c extra"], reason: "x" }))} }]; true`);
  const cl = await E(`classify("write a report").then(r => r.crit)`);
  check("moderate work gets at most 4 'done when' statements from the router", Array.isArray(cl) && cl.length === 4 && cl[0] === "report.md exists", J(cl));
  check("simple work gets none", (await E(`doneWhen(["x"], "simple").length`)) === 0);

  // a file the answer names that is not there: the program finds it, the agent gets a fix round, and the answer says so if it is still wrong
  const missing = path.join(W, "report.md");
  const rd = { tools: [{ name: "read_file", input: { path: path.join(W, "notes.txt") } }] };
  await E(`go("make report.md", [{ tools: [{ name: "read_file", input: { path: ${J(path.join(W, "notes.txt"))} } }] }, { text: ${J("I created " + missing + " for you.")} }, { text: "PASS" }, { text: ${J("Done, " + missing + " is ready.")} }], ["report.md exists"])`);
  await until("__done");
  const r1 = String(await E("__res")), vd = await E("TASK.verdict");
  check("a claimed file that does not exist is caught even when the AI checker says PASS", vd === "problems" || vd === "fixed", vd);
  check("after the fix round the answer says honestly that it is still missing", /Note from OmniGPT/.test(r1) && /report\.md/.test(r1), r1);

  // an example path or a place to look is not a claim that a file was made
  await E(`go("explain", [${J(rd)}, { text: ${J("For example, a file like " + path.join(W, "sample-not-made.md") + " would work.")} }, { text: "PASS" }], ["it explained"])`);
  await until("__done");
  check("a path mentioned as an example does not force a fix round", (await E("TASK.verdict")) === "pass", await E("TASK.verdict"));

  // an agent that admits it could not do it after the fix round is not given a false-claim note
  await E(`go("make report.md", [{ tools: [{ name: "read_file", input: { path: ${J(path.join(W, "notes.txt"))} } }] }, { text: ${J("I created " + missing + " for you.")} }, { text: "PASS" }, { text: "Sorry, I could not create it." }], ["report.md exists"])`);
  await until("__done");
  check("an honest admission after the fix round gets no note", !/Note from OmniGPT/.test(String(await E("__res"))));

  // an existing file passes, and the check says the file was verified
  await E(`go("show notes", [{ tools: [{ name: "read_file", input: { path: ${J(path.join(W, "notes.txt"))} } }] }, { text: ${J("I saved it to " + path.join(W, "notes.txt") + ".")} }, { text: "PASS" }], ["the answer names the note file"])`);
  await until("__done");
  check("an existing file passes and is marked verified on disk", (await E("TASK.verdict")) === "pass" && /verified on disk/.test(await E("document.body.textContent")));

  // the personal test set
  await E(`LS.set("orc.cases", []); LS.set("orc.settings", { ...(LS.get("orc.settings") || {}), cases: undefined }); history = [{}, {}]; TURN = { ok: 1, fail: 0, written: [], kind: "web", tok: 900 }; CHAT_DIR = null; TASK = { criteria: ["states the version"], cx: "moderate", verdict: "pass" }; recordCase("What is the latest Node.js version?", "Node 24."); true`);
  check("a defined request that did not touch the user's files is kept", (await E(`LS.get("orc.cases").length`)) === 1);
  await E(`recordCase("what is the  latest node.js version?", "Node 24."); true`);
  check("the same request is not kept twice", (await E(`LS.get("orc.cases").length`)) === 1);
  await E(`TURN.readLocal = true; recordCase("Summarize my notes", "ok"); TURN.readLocal = false; TURN.written = ["C:\\\\x.txt"]; recordCase("Make a file", "ok"); TURN.written = []; TURN.fail = 1; recordCase("A failing one", "ok"); TURN.fail = 0; true`);
  check("requests that read or wrote the user's files, or failed, are not kept", (await E(`LS.get("orc.cases").length`)) === 1);
  await E(`LS.set("orc.settings", { cases: false }); recordCase("Another question", "ok"); true`);
  check("the setting 'cases: false' turns it off", (await E(`LS.get("orc.cases").length`)) === 1);

  // ---- 3. replay.mjs
  const { pick, compare } = await import(pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "replay.mjs")).href);
  const L = [{ q: "a" }, { q: "b" }, { q: "c" }];
  check("replay picks by number and keeps the newest when limited", pick(L, { only: [2] })[0].q === "b" && pick(L, { limit: 2 }).map((c) => c.q).join("") === "bc");
  check("replay flags a case that used to pass and now fails", compare({ pass: false, tokens: 10 }, { pass: true, tokens: 10 }).tag === "REGRESSION");
  check("replay notices a case that got fixed, and a big token change", compare({ pass: true, tokens: 100 }, { pass: false, tokens: 10 }).tag === "fixed" && /\+900%/.test(compare({ pass: true, tokens: 100 }, { pass: true, tokens: 10 }).note));
  check("no page errors", !app.logs.length, app.logs.join("; "));
} catch (e) { check("verify test", false, e.stack || e.message); }
finally { if (app) await app.close(); fs.rmSync(W, { recursive: true, force: true }); }
console.log(failed ? `${failed} check(s) failed.` : "All verification checks passed.");
process.exit(failed ? 1 : 0);
