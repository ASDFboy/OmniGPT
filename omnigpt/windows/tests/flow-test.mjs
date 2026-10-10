// Built with Claude (Anthropic) - see CREDITS.md
// The start of each request, in the real page with a fake model where every call takes about 300 ms: the router runs at
// the same time as the refiner, the agent gets only the tool groups it needs (more_tools adds more), and old messages that
// no longer fit become a short summary. Run: node flow-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openApp, src } from "./pagekit.mjs";

let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + String(extra).replace(/\s+/g, " ") : "")); };
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-flow-test-" + process.pid);
const J = (v) => JSON.stringify(v);

// Installed in the page: the fake model. Each kind of caller is told apart by its system prompt. Every call is recorded
// (when it started, the tools and messages it got) and waits FAKE.delay ms, or FAKE.slow[kind]; a call that would take
// longer than its timeout fails the way a slow model does.
const FAKE = `(() => {
  window.FAKE = { calls: [], queue: { agent: [], helper: [], worker: [] }, n: 0, delay: 300, slow: {}, router: "", refine: "CLEAR", summary: "", harm: false, plan: "" };
  const kinds = [["router", /^Classify the user's request for a router/], ["refiner", /^You prepare a user's request/], ["summary", /^You keep a running summary/],
    ["reviewer", /You review ONE action/], ["learn", /^You maintain a long-term memory/], ["harm", /^You classify a user request for a routing system/],
    ["planner", /^You split a task into/], ["helper", /YOU ARE A HELPER AGENT/], ["worker", /YOU ARE WORKER W/]];
  const who = (a) => (kinds.find(([, re]) => re.test(String(a.system || ""))) || ["agent"])[0];
  const wait = (ms, a) => new Promise((ok, bad) => { if (a.timeout && ms > a.timeout) setTimeout(() => bad(new DOMException("model timed out", "TimeoutError")), a.timeout); else setTimeout(ok, ms); });
  stream = async (a, ui, noThink, out) => {
    const w = who(a), c = { who: w, t: performance.now(), model: a.model, timeout: a.timeout, tools: (a.tools || []).map((t) => t.name), toolsJson: a.tools ? JSON.stringify(a.tools).length : 0,
      system: String(a.system || ""), messages: JSON.parse(JSON.stringify(a.messages || [])) };
    FAKE.calls.push(c);
    await wait(w in FAKE.slow ? FAKE.slow[w] : FAKE.delay, a);
    let r;
    if (w === "router") { if (FAKE.router === "FAIL") throw new Error("503 router unavailable"); r = { text: FAKE.router }; }
    else if (w === "refiner") r = { text: FAKE.refine };
    else if (w === "summary") { if (FAKE.summary === "FAIL") throw new Error("503 summary unavailable"); r = { text: FAKE.summary }; }
    else if (w === "reviewer") r = { text: '{"verdict":"safe","risk":"low","reason":"ordinary work"}' };
    else if (w === "learn") r = { text: "{}" };
    else if (w === "harm") r = { text: J0({ protected: FAKE.harm, category: FAKE.harm ? "weapons" : "none" }) };
    else if (w === "planner") r = { text: FAKE.plan };
    else r = FAKE.queue[w === "helper" || w === "worker" ? w : "agent"].shift() || { text: "(script ran out)" };
    if (out) { out.content = [...(r.text ? [{ type: "text", text: r.text }] : []), ...(r.tools || []).map((t) => ({ type: "tool_use", id: "tu" + (++FAKE.n), name: t.name, input: t.input }))]; out.stop = r.tools && r.tools.length ? "tool_use" : "end_turn"; }
    if (ui && r.text) ui.text(r.text);
    return r.text || "";
  };
  const J0 = (v) => JSON.stringify(v);
  window.results = (w) => FAKE.calls.filter((c) => c.who === w).map((c) => c.messages[c.messages.length - 1]).filter((m) => m && Array.isArray(m.content))
    .map((m) => m.content.filter((b) => b.type === "tool_result").map((b) => (b.is_error ? "ERR " : "") + (typeof b.content === "string" ? b.content : J0(b.content))));
  const firstAgent = (t0) => { const c = FAKE.calls.find((c) => c.who === "agent"); return c ? Math.round(c.t - t0) : -1; };
  // one request through send(), as the user sends it
  window.ask = async (q, steps = [{ text: "Done." }], more = {}) => {
    FAKE.calls = []; FAKE.queue.agent = steps; FAKE.queue.helper = more.helper || []; FAKE.queue.worker = more.worker || [];
    const t0 = performance.now(); input.value = q; await send();
    return { first: firstAgent(t0), ms: Math.round(performance.now() - t0), answer: ([...document.querySelectorAll(".turn.final .body")].pop() || {}).textContent || "", busy };
  };
  // the order send() used before: the refiner, then the router inside auto(), then the agent
  window.askOld = async (q, steps = [{ text: "Done." }]) => {
    FAKE.calls = []; FAKE.queue.agent = steps; const t0 = performance.now();
    TURN = { id: uid(), untrusted: false, tok: 0, ok: 0, fail: 0, written: [], t0: Date.now() }; TASK = { request: q, plan: "", criteria: [], tests: "", decisions: [] };
    trace = mkTrace(); ctrl = new AbortController(); busy = true;
    try { const b = await refine(q); const rq = b && !/^ASK:/i.test(b) ? briefed(q, b) : q; await auto(rq, [{ role: "user", content: rq }]); }
    finally { trace.finish(); trace = null; busy = false; ctrl = null; }
    return { first: firstAgent(t0) };
  };
  return true;
})()`;

const route = (o) => J({ complexity: "simple", tools: true, parallel: false, compute: false, web: false, reason: "test", ...o });
const RENAME = "Rename report.txt to report.md in my workspace";
// messages sized to the page's context budget (2900 characters each when it was 24000), so the same counts drop out
const BUDGET = Number((/const CTX_BUDGET=(\d+)/.exec(fs.readFileSync(path.join(src, "app.js"), "utf8")) || [, 24000])[1]);
const long = (tag, n = Math.round(2900 * BUDGET / 24000)) => (tag + " ").repeat(Math.ceil(n / (tag.length + 1))).slice(0, n);
const pairs = (tag, k) => Array.from({ length: k }, (_, i) => [{ role: "user", content: long(tag + "q" + i) }, { role: "assistant", content: long(tag + "a" + i) }]).flat();

let app;
try {
  fs.mkdirSync(W, { recursive: true });
  app = await openApp({ port: "20201" });
  const E = (js, ms) => app.evaluate(js, ms);
  check("the page loads against a fresh backend", await E(FAKE));
  await E(`LS.set("orc.settings", { ...SET(), learn: false, refine: true }); applySettings(); $("#pc").checked = true; true`);
  const calls = (w) => E(`FAKE.calls.filter((c) => c.who === ${J(w)})`);

  // ---- 1. the router and the refiner at the same time
  await E(`FAKE.router = ${J(route({ groups: ["files"] }))}; FAKE.refine = "CLEAR"; newChat(); true`);
  const after = await E(`ask(${J(RENAME)})`);
  const rt = await E(`(() => { const r = FAKE.calls.find((c) => c.who === "router"), f = FAKE.calls.find((c) => c.who === "refiner"); return { r: r && r.t, f: f && f.t, q: r && r.messages[0].content }; })()`);
  await E(`newChat(); true`);
  const before = await E(`askOld(${J(RENAME)})`);
  console.log(`      time from send to the first agent call, every model call ~300 ms: before ${before.first} ms (refiner, then router), after ${after.first} ms (both at once)`);
  check("the router and the refiner start together", rt.r && rt.f && Math.abs(rt.r - rt.f) < 60, J(rt).slice(0, 120));
  check("the router reads the user's own words", rt.q === RENAME, rt.q);
  check("the agent starts after about one model call instead of two", after.first > 250 && after.first < 500 && before.first > 560 && before.first - after.first > 200, `before ${before.first} ms, after ${after.first} ms`);
  check("the answer arrives", /Done\./.test(after.answer) && !after.busy, after.answer.slice(0, 60));

  const BRIEF = "Rename the file report.txt in the workspace to report.md. Assumption: the workspace is the working folder.";
  await E(`FAKE.refine = ${J(BRIEF)}; newChat(); true`);
  await E(`ask(${J(RENAME)})`);
  const ag = (await calls("agent"))[0] || { messages: [] }, last = ag.messages[ag.messages.length - 1] || {};
  check("the refiner's brief still goes to the agent", typeof last.content === "string" && last.content.startsWith(RENAME) && last.content.includes("[Clarified brief for the agents") && last.content.includes(BRIEF), String(last.content).slice(0, 120));
  check("the history keeps the user's own words", await E(`history[history.length - 2].content === ${J(RENAME)}`));

  await E(`FAKE.refine = "ASK: Which report file do you mean?"; newChat(); true`);
  const asked = await E(`ask(${J(RENAME)})`);
  check("a question from the refiner stops and asks, no agent runs", (await calls("agent")).length === 0 && /Which report file do you mean\?/.test(asked.answer) && !asked.busy, asked.answer.slice(0, 80));
  check("the router that ran alongside has finished before the question is shown", (await calls("router")).length === 1 && asked.ms < 550, asked.ms + " ms");

  await E(`FAKE.refine = "CLEAR"; FAKE.router = "FAIL"; newChat(); true`);
  await E(`ask(${J(RENAME)})`);
  const fb = (await calls("agent"))[0] || { tools: [] }, allNames = await E(`TOOLS.map((t) => t.name)`);
  check("when every router fails, the old guess still routes it (a PC agent here)", (await calls("router")).length === 2 && fb.tools.length > 0);
  check("router failure: the agent gets every tool", J(fb.tools) === J(allNames), fb.tools.length + " of " + allNames.length);

  await E(`FAKE.router = ${J(route({ groups: ["files"] }))}; setSet("mode", "unfiltered"); FAKE.harm = true; newChat(); true`);
  const blocked = await E(`ask(${J(RENAME)})`);
  check("unfiltered mode: a protected request asks no other model", /Unfiltered mode does not cover this request/.test(blocked.answer) && J(await E(`FAKE.calls.map((c) => c.who)`)) === J(["harm"]), J(await E(`FAKE.calls.map((c) => c.who)`)));
  await E(`FAKE.harm = false; newChat(); true`);
  await E(`ask(${J(RENAME)})`);
  const order = await E(`FAKE.calls.map((c) => c.who)`);
  check("unfiltered mode: the harm check still comes first", order[0] === "harm" && order.includes("router") && order.includes("agent"), J(order));
  await E(`setSet("mode", "default"); true`);

  // ---- 2. tool groups
  check("group names from a model are cleaned up", await E(`JSON.stringify(normGroups(["file", "Media", "bogus"])) === '["files","media"]' && normGroups(["bogus"]) === null && normGroups(["constructor"]) === null && JSON.stringify(normGroups([])) === "[]" && JSON.stringify(normGroups(["core"])) === "[]" && normGroups(undefined) === null`));
  check("every tool group names real tools", await E(`Object.values(TOOL_GROUPS).flat().every((n) => TOOLS.some((t) => t.name === n))`));
  await E(`newChat(); true`);
  await E(`ask(${J(RENAME)})`);
  const fr = (await calls("agent"))[0] || { tools: [], toolsJson: 0, system: "" };
  const allJson = await E(`JSON.stringify(TOOLS).length`);
  console.log(`      tools sent with each agent call for "${RENAME}": before ${allNames.length} tools, ${allJson} characters of JSON; after ${fr.tools.length} tools, ${fr.toolsJson} characters`);
  check("a rename request offers the core and file tools", ["read_file", "list_dir", "find_files", "ask_user", "move_file", "write_file", "edit_file", "more_tools"].every((t) => fr.tools.includes(t)), fr.tools.join(","));
  check("... but not media, account, web or command tools", !["view_images", "edit_image", "send_message", "github", "calendar_events", "web_search", "run_command"].some((t) => fr.tools.includes(t)), fr.tools.join(","));
  check("the tool list sent per call is much smaller", fr.toolsJson > 0 && fr.toolsJson < allJson * 0.6, `${fr.toolsJson} vs ${allJson}`);
  check("the agent is told how to get tools it lacks", /call more_tools with its group/.test(fr.system));

  const Wj = J(W);
  await E(`newChat(); true`);
  await E(`ask(${J(RENAME + ", then make cover.png smaller")}, [
    { text: "Making it smaller.", tools: [{ name: "edit_image", input: { path: "cover.png", resize: "50%" } }] },
    { text: "I need the media tools.", tools: [{ name: "more_tools", input: { groups: ["media"], reason: "resize cover.png" } }] },
    { tools: [{ name: "view_images", input: { paths: [${Wj} + "/none.png"] } }, { name: "send_message", input: { connection: "team", text: "hi" } }] },
    { tools: [{ name: "more_tools", input: { groups: ["media"] } }, { name: "more_tools", input: { groups: ["nonsense"] } }] },
    { text: "Done." }])`);
  const steps = await calls("agent"), R = await E(`results("agent")`);
  const st = (k) => (R[k] || []).join(" | ");
  check("a tool outside the offered groups is refused", /^ERR .*edit_image is not available here/.test(st(0)), st(0).slice(0, 100));
  const added = (/^Added (.+?)\. You can use them from your next step\.$/.exec(st(1)) || [, ""])[1].split(", ").sort();
  check("more_tools adds the media group", J(added) === J(["convert_media", "edit_image", "generate_image", "speak", "transcribe_audio", "view_images"]), st(1).slice(0, 120));
  check("the added tools are offered from the next step on", steps[2] && ["view_images", "edit_image", "speak"].every((t) => steps[2].tools.includes(t)) && !steps[1].tools.includes("view_images"), steps[2] && steps[2].tools.length + " tools");
  check("an added tool really runs", R[2] && R[2][0] && !/not available here/.test(R[2][0]), (R[2] || [])[0]);
  check("a tool from a group still not added is refused", R[2] && /^ERR .*send_message is not available here/.test(R[2][1] || ""), (R[2] || [])[1]);
  check("asking again for the same group, or a made-up one, changes nothing", /already have every tool in media/.test((R[3] || [])[0] || "") && /^ERR .*groups is required/.test((R[3] || [])[1] || "") && steps[4] && steps[4].tools.length === steps[2].tools.length, J(R[3]));

  await E(`FAKE.router = ${J(route({}))}; newChat(); true`);
  await E(`ask(${J(RENAME)})`);
  const ng = (await calls("agent"))[0] || { tools: [] };
  check("no groups from the router: every tool", J(ng.tools) === J(allNames), ng.tools.length + " tools");

  await E(`TOOLS.push({ name: "zz_new_tool", description: "A tool added later by someone else.", input_schema: { type: "object", properties: {}, required: [] } }); FAKE.router = ${J(route({ groups: [] }))}; newChat(); true`);
  await E(`ask("What does notes.txt in my workspace say?")`);
  const nt = (await calls("agent"))[0] || { tools: [] };
  await E(`TOOLS.pop(); true`);
  check("a tool in no group is always offered", nt.tools.includes("zz_new_tool") && nt.tools.includes("read_file") && !nt.tools.includes("write_file"), nt.tools.join(","));

  await E(`FAKE.router = ${J(route({ groups: ["files"], web: true }))}; newChat(); true`);
  await E(`ask("Download the latest Node.js notes and save them in my workspace")`);
  const wl = (await calls("agent"))[0] || { tools: [], system: "" };
  check("a web request gets the web group too, with the web rules", ["web_search", "web_open", "write_file", "more_tools"].every((t) => wl.tools.includes(t)) && /web_search and web_open/.test(wl.system) && /call more_tools/.test(wl.system), wl.tools.join(","));

  await E(`FAKE.router = ${J(route({ groups: ["helpers"] }))}; newChat(); true`);
  await E(`ask("Count the files in my workspace with a helper", [{ tools: [{ name: "delegate", input: { title: "Count", instructions: "List " + ${Wj} + " and count the files.", tools: "read" } }] }, { text: "Done." }],
    { helper: [{ tools: [{ name: "more_tools", input: { groups: ["files"] } }] }, { text: "REPORT: 0 files." }] })`);
  const hm = (await calls("agent"))[0] || { tools: [] }, hc = (await calls("helper"))[0] || { tools: [] }, HR = await E(`results("helper")`);
  check("the main agent gets the helpers group", hm.tools.includes("delegate") && hm.tools.includes("more_tools"), hm.tools.join(","));
  check("a helper keeps its own list, without more_tools", hc.tools.includes("list_dir") && hc.tools.includes("view_images") && !hc.tools.includes("more_tools") && !hc.tools.includes("write_file"), hc.tools.join(","));
  check("a helper cannot call more_tools", /^ERR .*more_tools is not available here/.test((HR[0] || [])[0] || ""), (HR[0] || [])[0]);

  await E(`FAKE.router = ${J(route({ complexity: "moderate", groups: ["files"], parallel: true }))};
    FAKE.plan = ${J(J({ parallel: true, shared: "", subtasks: [{ title: "Part A", instructions: "Write a.txt", check: "", after: [], writes: [".omnigpt-flow-test-" + process.pid + "/A"] }, { title: "Part B", instructions: "Write b.txt", check: "", after: [], writes: [".omnigpt-flow-test-" + process.pid + "/B"] }] }))}; newChat(); true`);
  await E(`ask("Write a.txt and b.txt in two folders of my workspace", [{ text: "Done." }], { worker: [{ text: "REPORT A" }, { text: "REPORT B" }] })`);
  const wk = await calls("worker"), integ = (await calls("agent"))[0] || { tools: [], messages: [] };
  check("parallel workers keep their own tool lists", wk.length === 2 && wk.every((c) => c.tools.includes("edit_image") && c.tools.includes("make_document") && !c.tools.includes("more_tools")), wk.map((c) => c.tools.length).join(","));
  check("the integrator after the workers gets the chosen groups", integ.tools.includes("write_file") && integ.tools.includes("more_tools") && !integ.tools.includes("edit_image") && /Parallel workers finished/.test(J(integ.messages)), integ.tools.length + " tools");

  // ---- 3. summaries instead of dropping old messages
  const SUM1 = "Facts: the user is planning a trip to Lisbon in May. Files: C:\\Trips\\plan.md. Open items: book the hotel.";
  const H1 = pairs("old", 10), Q1 = "What should I pack for the trip we planned?";
  await E(`FAKE.router = ${J(route({ tools: false, groups: [] }))}; FAKE.summary = ${J(SUM1)}; newChat(); history = ${J(H1)}; true`);
  const s1 = await E(`ask(${J(Q1)})`);
  const sc = await calls("summary"), a1 = (await calls("agent"))[0] || { messages: [] };
  const head = await E(`SUMHEAD`), id1 = await E(`chatId`), store1 = await E(`LS.get("orc.summaries") || {}`);
  const dropped1 = await E(`fitSplit(${J([...H1, { role: "user", content: Q1 }])}).drop.length`);
  check("old messages that do not fit are summarized by a fast model", sc.length === 1 && (await E(`TIERS.fast.includes(${J((sc[0] || {}).model)})`)) && /oldq0/.test(sc[0].messages[0].content) && !/oldq9/.test(sc[0].messages[0].content), (sc[0] || { messages: [{}] }).messages[0].content?.slice(0, 80));
  check("the summary sits where the dropped messages were", a1.messages[0] && a1.messages[0].content === head + SUM1 && a1.messages[1].content === "Understood." && a1.messages[a1.messages.length - 1].content === Q1, String(a1.messages[0] && a1.messages[0].content).slice(0, 100));
  check("summarizing does not hold up the agent (it runs with the router and refiner)", s1.first > 250 && s1.first < 500, s1.first + " ms");
  check("the summary is cached per chat and number of dropped messages", store1[id1 + ":" + dropped1] && store1[id1 + ":" + dropped1].s === SUM1, Object.keys(store1).join(","));
  check("the conversation keeps the summary for the next request", await E(`history[0].content === ${J(head + SUM1)}`));

  const M1 = [...H1, { role: "user", content: Q1 }];
  await E(`FAKE.calls = []; true`);
  const again = await E(`fitCtxA(${J(M1)})`);
  check("the same messages again: the cached summary, no model call", (await calls("summary")).length === 0 && again[0].content === head + SUM1);

  const SUM2 = "Facts: Lisbon trip in May; packing list started. Open items: book the hotel, buy adapters.";
  const M2 = [...M1, { role: "assistant", content: long("olda10") }, ...pairs("newer", 4), { role: "user", content: "And what about adapters?" }];
  await E(`FAKE.calls = []; FAKE.summary = ${J(SUM2)}; true`);
  const ext = await E(`fitCtxA(${J(M2)})`);
  const sc2 = (await calls("summary"))[0] || { messages: [{ content: "" }] }, in2 = sc2.messages[0].content, store2 = await E(`LS.get("orc.summaries") || {}`), d2 = await E(`fitSplit(${J(M2)}).drop.length`);
  check("more dropped messages extend the cached summary instead of starting over", in2.startsWith("Earlier summary:\n" + SUM1) && !/oldq0/.test(in2) && /oldq\d|olda\d|newerq/.test(in2) && ext[0].content === head + SUM2, in2.slice(0, 120));
  check("one cache entry per chat", store2[id1 + ":" + d2] && !store2[id1 + ":" + dropped1], Object.keys(store2).join(","));

  const SUM3 = "Facts: Lisbon trip in May; adapters needed. Open items: book the hotel.";
  await E(`FAKE.summary = ${J(SUM3)}; history = [...history, ...${J(pairs("later", 8))}]; true`);
  await E(`ask("Make me a final checklist for the trip")`);
  const in3 = ((await calls("summary"))[0] || { messages: [{ content: "" }] }).messages[0].content, a3 = (await calls("agent"))[0] || { messages: [] };
  check("a summary already in the conversation is extended too", in3.startsWith("Earlier summary:\n" + SUM1) && /laterq0/.test(in3) && !/oldq0/.test(in3) && a3.messages[0] && a3.messages[0].content === head + SUM3, in3.slice(0, 120));

  await E(`FAKE.summary = "FAIL"; newChat(); history = ${J(pairs("fail", 10))}; true`);
  const f1 = await E(`ask(${J(Q1)})`), af = (await calls("agent"))[0] || { messages: [] };
  check("a failed summary leaves the short note, and the answer still comes", af.messages[0] && af.messages[0].content === (await E(`OMITTED`)) && /Done\./.test(f1.answer), String(af.messages[0] && af.messages[0].content).slice(0, 80));

  check("the summary waits at most 15 seconds", (await E(`SUM_MS`)) === 15000);
  await E(`SUM_MS = 1200; FAKE.summary = ${J(SUM1)}; FAKE.slow = { summary: 8000 }; newChat(); history = ${J(pairs("slow", 10))}; true`);
  const sl = await E(`ask(${J(Q1)})`), as = (await calls("agent"))[0] || { messages: [] };
  await E(`SUM_MS = 15000; FAKE.slow = {}; true`);
  check("a slow summary gives up in time: short note, the agent starts anyway", as.messages[0] && as.messages[0].content === (await E(`OMITTED`)) && sl.first > 1100 && sl.first < 2500, sl.first + " ms");

  await E(`LS.set("orc.summaries", Object.fromEntries(Array.from({ length: 205 }, (_, k) => ["old" + k + ":3", { h: "x", s: "old summary " + k, ts: 1000 + k }]))); FAKE.summary = ${J(SUM1)}; newChat(); history = ${J(pairs("store", 10))}; true`);
  await E(`ask(${J(Q1)})`);
  const st3 = await E(`LS.get("orc.summaries")`), id3 = await E(`chatId`);
  check("the summary store stays small (the last 200 chats)", Object.keys(st3).length === 200 && Object.keys(st3).some((k) => k.startsWith(id3 + ":")) && !st3["old0:3"], Object.keys(st3).length + " entries");
  await new Promise((r) => setTimeout(r, 600));
  const disk = await (await fetch(app.base + "/api/kv", { headers: { "x-app-token": await E("TOKEN") } })).json();
  check("summaries are saved to disk by the backend", disk["orc.summaries"] && Object.keys(disk["orc.summaries"]).length === 200);
  await E(`delChat(chatId); true`);
  check("deleting a chat deletes its summary", !Object.keys(await E(`LS.get("orc.summaries")`)).some((k) => k.startsWith(id3 + ":")) && Object.keys(await E(`LS.get("orc.summaries")`)).length === 199);
  check("no errors in the page", app.logs.length === 0, app.logs.join("; ").slice(0, 300));
} catch (e) { check("flow test", false, String(e.stack || e).slice(0, 600)); }
if (app) await app.close();
fs.rmSync(W, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed.` : "All request-start checks passed.");
process.exit(failed ? 1 : 0);
