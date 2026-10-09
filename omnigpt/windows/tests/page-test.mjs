// The tools that run inside the page (remember / recall / forget, todo, delegate), tested in the real page with a fake
// model: the page's stream() is replaced by a script, everything else (agent loop, tool cards, approvals, the backend)
// is the real code. Run: node page-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openApp, src as appDir } from "./pagekit.mjs";

let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-page-test-" + process.pid);

// Installed in the page: the fake model. Each agent (main, helper) answers from its own queue of steps; the safety
// reviewer always says "safe". Every call is recorded so the test can see what each agent was given.
const FAKE = `(() => {
  window.FAKE = { calls: [], queues: { main: [], helper: [] }, n: 0 };
  const who = (a) => /You review ONE action/.test(a.system || "") ? "reviewer" : /YOU ARE A HELPER AGENT/.test(a.system || "") ? "helper" : "main";
  stream = async (a, ui, noThink, out) => {
    const w = who(a);
    FAKE.calls.push({ who: w, system: String(a.system || ""), tools: (a.tools || []).map((t) => t.name), messages: JSON.parse(JSON.stringify(a.messages || [])) });
    if (w === "reviewer") return '{"verdict":"safe","risk":"low","reason":"ordinary work"}';
    const r = FAKE.queues[w].shift() || { text: "(script ran out)" };
    if (out) { out.content = [...(r.text ? [{ type: "text", text: r.text }] : []), ...(r.tools || []).map((t) => ({ type: "tool_use", id: "tu" + (++FAKE.n), name: t.name, input: t.input }))]; out.stop = r.tools && r.tools.length ? "tool_use" : "end_turn"; }
    if (ui && r.text) ui.text(r.text);
    return r.text || "";
  };
  // what the tools answered, step by step: the tool results the agent sent back to the model
  window.results = (w) => FAKE.calls.filter((c) => c.who === w).map((c) => c.messages[c.messages.length - 1]).filter((m) => m && Array.isArray(m.content))
    .map((m) => m.content.filter((b) => b.type === "tool_result").map((b) => (b.is_error ? "ERR " : "") + (typeof b.content === "string" ? b.content : JSON.stringify(b.content))));
  // one request, as send() starts it, without the router: the agent loop with the main agent's script
  window.runTurn = async (q, steps, helper = []) => {
    FAKE.calls = []; FAKE.queues.main = steps; FAKE.queues.helper = helper;
    ctrl = new AbortController(); busy = true; DELEGATES = 0;
    TURN = { id: uid(), untrusted: false, tok: 0, ok: 0, fail: 0, written: [], t0: Date.now() }; trace = mkTrace();
    try { return await agent(q, [{ role: "user", content: q }], ["fake/main-model"]); }
    finally { trace.finish(); busy = false; ctrl = null; }
  };
  return true;
})()`;

let app;
try {
  fs.mkdirSync(W, { recursive: true });
  fs.writeFileSync(path.join(W, "a.txt"), "first"); fs.writeFileSync(path.join(W, "b.txt"), "second");
  app = await openApp({ port: "20171" });
  const E = (js, ms) => app.evaluate(js, ms);
  check("the page loads against a fresh backend", await E(FAKE));
  const J = (v) => JSON.stringify(v);

  // ---- remember / recall / forget
  await E(`LS.set("orc.memories", [])`);
  let final = await E(`runTurn("Remember a few things about me", [
    { text: "Saving that.", tools: [{ name: "remember", input: { text: "The user's name is Ada Lovelace", kind: "user" } }] },
    { tools: [{ name: "remember", input: { text: "the user's name is ada lovelace" } }] },
    { tools: [{ name: "remember", input: { text: "My password is hunter2" } }] },
    { tools: [{ name: "remember", input: { text: "Prefers short answers in bullet points", kind: "preference" } }] },
    { tools: [{ name: "recall", input: { query: "name" } }] },
    { tools: [{ name: "forget", input: { query: "lovelace" } }] },
    { tools: [{ name: "recall", input: {} }] },
    { tools: [{ name: "forget", input: { query: "e" } }] },
    { text: "Done." }])`);
  let R = await E(`results("main")`);
  const step = (k) => (R[k] || []).join(" | ");
  check("remember saves a memory", /^Saved to memory: The user's name is Ada Lovelace/.test(step(0)), step(0));
  check("remembering the same thing again updates it instead of adding a copy", /^Updated an existing memory/.test(step(1)), step(1));
  check("secrets are never saved", /^ERR .*secret/.test(step(2)), step(2));
  check("recall finds memories by topic", /Ada Lovelace/i.test(step(4)) && !/bullet points/.test(step(4)), step(4));
  check("forget removes matching memories", /^Forgot 1 memory: the user's name is ada lovelace/i.test(step(5)), step(5));
  check("recall with no query lists everything that is left", /\[preference\] Prefers short answers/.test(step(6)) && !/Lovelace/i.test(step(6)), step(6));
  check("forget refuses a vague one-letter match (would wipe most memories)", /^ERR .*at least 3 characters/.test(step(7)), step(7));
  check("the agent's final answer comes back with its actions", /^Done\.[\s\S]*\[Actions this turn: remember, remember, remember \(not done\), remember, recall, forget, recall, forget \(not done\)\]/.test(final), final.slice(-160));
  const mem = await E(`MEM().map(m=>({text:m.text,kind:m.kind}))`);
  check("exactly one memory is left, with its kind", mem.length === 1 && mem[0].kind === "preference", J(mem));
  // the page stores memories through the backend, so they survive closing the window
  await new Promise((r) => setTimeout(r, 800));
  const token = await E("TOKEN");
  const disk = await (await fetch(app.base + "/api/kv", { headers: { "x-app-token": token } })).json();
  check("memories are saved to disk by the backend", Array.isArray(disk["orc.memories"]) && disk["orc.memories"].length === 1 && /short answers/.test(disk["orc.memories"][0].text), J(disk["orc.memories"]).slice(0, 120));
  // many matches: nothing removed, ids listed instead
  await E(`LS.set("orc.memories", Array.from({length: 7}, (_, k) => ({ id: "m" + k, text: "Project note number " + k + " about invoices", kind: "fact", ts: Date.now() })))`);
  await E(`runTurn("forget invoices", [{ tools: [{ name: "forget", input: { query: "invoices" } }] }, { tools: [{ name: "forget", input: { id: "m3" } }] }, { text: "ok" }])`);
  R = await E(`results("main")`);
  check("a broad forget removes nothing and lists the ids", /^7 memories contain "invoices", so none were removed/.test(step(0)) && /m6  Project note number 6/.test(step(0)), step(0).slice(0, 90));
  check("forget by id removes exactly that one", /^Forgot 1 memory: Project note number 3/.test(step(1)) && (await E(`MEM().length`)) === 6, step(1));
  // the Memory setting is respected
  await E(`LS.set("orc.settings", { ...(LS.get("orc.settings") || {}), memory: false })`);
  await E(`runTurn("remember", [{ tools: [{ name: "remember", input: { text: "Lives in Lisbon" } }] }, { text: "ok" }])`);
  R = await E(`results("main")`);
  check("with Memory turned off nothing is saved", /Memory is turned off/.test(step(0)) && !(await E(`MEM().some(m=>/Lisbon/.test(m.text))`)), step(0));
  await E(`LS.set("orc.settings", { ...(LS.get("orc.settings") || {}), memory: true })`);

  // ---- todo
  await E(`runTurn("Sort my files in three steps", [
    { text: "Planning.", tools: [{ name: "todo", input: { items: [{ text: "Find the files", status: "doing" }, { text: "Sort them" }, { text: "Report" }] } }] },
    { tools: [{ name: "todo", input: { items: [{ text: "Find the files", status: "done" }, { text: "Sort them", status: "doing" }, { text: "Report", status: "pending" }] } }] },
    { tools: [{ name: "todo", input: { items: [] } }] },
    { text: "All sorted." }])`);
  R = await E(`results("main")`);
  const todo = await E(`(() => { const L = [...document.querySelectorAll(".todo")]; const t = L[L.length - 1]; return { n: document.querySelectorAll(".todo").length, head: t && t.querySelector(".todo-h").textContent,
    items: t ? [...t.querySelectorAll(".todo-i")].map((i) => i.className + ":" + i.textContent) : [], visible: !!t && t.offsetParent !== null && getComputedStyle(t).display !== "none",
    inTrace: !!(t && t.closest(".trace")) }; })()`);
  check("todo reports progress to the agent", /^Checklist updated: 0 of 3 done/.test(step(0)) && /^Checklist updated: 1 of 3 done/.test(step(1)), step(1));
  check("the checklist card updates in place (one card per request)", todo.n === 1 && todo.head === "Checklist · 1 of 3 done", J(todo));
  check("checklist items show their status", J(todo.items) === J(["todo-i done:✓Find the files", "todo-i doing:›Sort them", "todo-i pending:○Report"]), J(todo.items));
  check("the checklist is visible without opening the reasoning", todo.visible && !todo.inTrace, J(todo));
  check("an empty checklist is refused", /^ERR .*items is required/.test(step(2)), step(2));
  await E(`runTurn("another request", [{ tools: [{ name: "todo", input: { items: ["Only step"] } }] }, { text: "ok" }])`);
  check("a new request gets its own checklist", (await E(`document.querySelectorAll(".todo").length`)) === 2 && (await E(`[...document.querySelectorAll(".todo")].pop().textContent`)).includes("0 of 1 done"));

  // ---- delegate
  const Wj = J(W);
  final = await E(`runTurn("MAIN-ONLY-CONTEXT: count the files in my folder", [
    { text: "I will hand this to a helper.", tools: [{ name: "delegate", input: { title: "Count files", instructions: "List the folder " + ${Wj} + " and report how many files it has.", tools: "read" } }] },
    { text: "The helper found 2 files." }],
    [{ text: "Listing.", tools: [{ name: "list_dir", input: { path: ${Wj} } }, { name: "write_file", input: { path: ${Wj} + "/sneaky.txt", content: "x" } }] },
     { text: "REPORT: the folder has 2 files: a.txt and b.txt." }])`);
  R = await E(`results("main")`);
  const helperCalls = await E(`FAKE.calls.filter((c) => c.who === "helper").map((c) => ({ tools: c.tools, system: c.system.slice(-700), first: c.messages[0].content }))`);
  const HR = await E(`results("helper")`);
  const h0 = helperCalls[0] || { tools: [], system: "", first: "" };
  check("the helper is told it is a helper and must report", /YOU ARE A HELPER AGENT/.test(h0.system) && /REPORT/.test(h0.system));
  check("the helper only sees its instructions, not the conversation", /^List the folder .* and report how many files it has\.$/.test(h0.first) && !/MAIN-ONLY-CONTEXT/.test(JSON.stringify(helperCalls)), String(h0.first).slice(0, 80));
  check("a read-only helper gets reading and web tools only", ["list_dir", "read_file", "web_search", "find_files"].every((t) => h0.tools.includes(t)) && !["write_file", "delete_file", "move_file", "run_command", "delegate", "ask_user", "remember", "todo", "install_tool"].some((t) => h0.tools.includes(t)), h0.tools.join(","));
  check("the helper's tool calls really run (list_dir)", /a\.txt/.test((HR[0] || [])[0] || ""), (HR[0] || [])[0]);
  check("a tool the helper was not given is refused, and nothing is written", /^ERR .*not available here/.test((HR[0] || [])[1] || "") && !fs.existsSync(path.join(W, "sneaky.txt")), (HR[0] || [])[1]);
  check("the main agent gets the helper's report", /^Report from helper 1 \(Count files\):\nREPORT: the folder has 2 files/.test(step(0)) && /\[Actions this turn: list_dir, write_file \(not done\)\]/.test(step(0)), step(0).slice(0, 120));
  check("the main agent's answer follows", /^The helper found 2 files\./.test(final));
  check("the helper works in its own lane in the reasoning", await E(`[...document.querySelectorAll(".trace")].pop().querySelector(".lane-h")?.textContent === "Helper 1 · Count files"`));

  // the other tool sets, the limit of 6 helpers and missing instructions
  await E(`runTurn("several helpers", [
    { tools: [{ name: "delegate", input: { title: "Web", instructions: "Find the latest Node version.", tools: "web" } }, { name: "delegate", input: { title: "All", instructions: "Tidy the notes folder." } },
      ...Array.from({ length: 5 }, (_, k) => ({ name: "delegate", input: { title: "Extra " + k, instructions: "Do part " + k } })), { name: "delegate", input: { title: "Empty", instructions: "  " } }] },
    { text: "ok" }], Array.from({ length: 6 }, (_, k) => ({ text: "REPORT " + k })))`);
  R = await E(`results("main")`);
  const tl = await E(`FAKE.calls.filter((c) => c.who === "helper").map((c) => c.tools)`);
  check("a web helper gets only the web tools", J(tl[0]) === J(["web_search", "web_open"]), J(tl[0]));
  check("a full helper can change files but cannot ask, delegate, schedule or touch memory", tl[1] && tl[1].includes("write_file") && tl[1].includes("run_command") && !["ask_user", "delegate", "schedule_task", "cancel_task", "clipboard", "remember", "forget", "todo"].some((t) => tl[1].includes(t)), (tl[1] || []).join(","));
  check("at most 6 helpers per request", tl.length === 6 && R[0].filter((x) => /^Report from helper/.test(x)).length === 6 && /^ERR .*too many helpers/.test(R[0][6] || ""), (R[0][6] || "").slice(0, 80));
  check("a helper without instructions is refused", /^ERR /.test(R[0][7] || ""), R[0][7]);
  await E(`runTurn("next request", [{ tools: [{ name: "delegate", input: { title: "Again", instructions: "One more." } }] }, { text: "ok" }], [{ text: "REPORT again" }])`);
  R = await E(`results("main")`);
  check("the helper count starts again with the next request", /^Report from helper 1 \(Again\)/.test(step(0)), step(0).slice(0, 60));
  // autonomous mode starts a fresh count and checklist every cycle
  check("autonomous cycles reset the helper count and checklist", /omni\.cycle\+\+;[^\n]*DELEGATES=0;TURN\.todoEl=null/.test(fs.readFileSync(path.join(appDir, "app.js"), "utf8")));
  // ---- background jobs: the start asks for approval, the header shows the running job, the list stops it
  fs.writeFileSync(path.join(W, "server.js"), "console.log('ready');setInterval(()=>console.log('tick'),300);");
  await E(`window.__job = runTurn("start my dev server", [{ tools: [{ name: "start_process", input: { command: "node server.js", cwd: ${Wj}, name: "dev server", until: "ready" } }] }, { text: "Started." }]); true`);
  let asked = false;
  for (let k = 0; k < 50 && !asked; k++) { asked = await E(`(() => { const b = document.querySelector(".act button[data-a=y]"); if (!b) return false; b.click(); return true; })()`); if (!asked) await new Promise((r) => setTimeout(r, 200)); }
  check("starting a background job asks for approval first", asked);
  await E(`window.__job`);
  R = await E(`results("main")`);
  check("the job starts and its first output comes back", /^<tool_output untrusted="true">\nStarted background job \d+ "dev server"/.test(step(0)) && /ready/.test(step(0)), step(0).slice(0, 120));
  const jobVisible = async () => E(`(() => { const e = document.getElementById("jobstat"); return !e.hidden && e.offsetParent !== null ? e.textContent : ""; })()`);
  let head = ""; for (let k = 0; k < 30 && !head; k++) { head = await jobVisible(); if (!head) await new Promise((r) => setTimeout(r, 200)); }
  check("the header shows the running job", head === "1 background job", head);
  await E(`document.getElementById("jobstat").click()`); await new Promise((r) => setTimeout(r, 600));
  const listed = await E(`(() => ({ open: document.getElementById("jdlg").open, text: document.getElementById("j-list").textContent, stop: !!document.querySelector("[data-jstop]") }))()`);
  check("the job list shows the job, its output and a Stop button", listed.open && /dev server/.test(listed.text) && /node server\.js/.test(listed.text) && /ready/.test(listed.text) && listed.stop, JSON.stringify(listed).slice(0, 160));
  await E(`document.querySelector("[data-jstop]").click()`);
  let gone = false; for (let k = 0; k < 40 && !gone; k++) { await new Promise((r) => setTimeout(r, 250)); gone = !(await jobVisible()); }
  check("Stop in the list ends the job and the header clears", gone && /stopped/.test(await E(`document.getElementById("j-list").textContent`)));
  await E(`document.getElementById("j-x").click()`);
  check("no errors in the page", app.logs.length === 0, app.logs.join("; ").slice(0, 300));
} catch (e) { check("page test", false, String(e.stack || e).slice(0, 600)); }
if (app) await app.close();
fs.rmSync(W, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed.` : "All page tool checks passed.");
process.exit(failed ? 1 : 0);
