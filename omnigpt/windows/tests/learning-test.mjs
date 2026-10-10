// Built with Claude (Anthropic) - see CREDITS.md
// Learning from results, in the real page with a fake model: per-kind model scores (verified answers, corrections, Undo,
// failed actions, empty replies; decay; ranking) and recipes (saved after verified success without contents, offered for a
// similar request, dropped after a failure), plus the benchmark harness in its scripted mode.
// Run: node learning-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openApp } from "./pagekit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-learning-test-" + process.pid);
const J = (v) => JSON.stringify(v);

// The fake model: the router, refiner, memory writer and safety reviewer answer by role; the agent answers from a queue.
// Every call is recorded with the model it was sent to, so the test sees which model was tried first.
const FAKE = `(() => {
  window.FAKE = { calls: [], queue: [], route: {}, n: 0 };
  const who = (s) => /Classify the user's request for a router/.test(s) ? "router" : /You prepare a user's request/.test(s) ? "refiner" : /You maintain a long-term memory/.test(s) ? "learn" : /You review ONE action/.test(s) ? "reviewer" : "main";
  stream = async (a, ui, noThink, out) => {
    const w = who(String(a.system || ""));
    FAKE.calls.push({ who: w, model: a.model, system: String(a.system || "") });
    if (w === "router") return JSON.stringify(FAKE.route);
    if (w === "refiner") return "CLEAR";
    if (w === "learn") return '{"memories":[],"skill":null}';
    if (w === "reviewer") return '{"verdict":"safe","risk":"low","reason":"ordinary work"}';
    const r = FAKE.queue.shift() || { text: "(script ran out)" };
    if (out) { out.content = [...(r.text ? [{ type: "text", text: r.text }] : []), ...(r.tools || []).map((t) => ({ type: "tool_use", id: "tu" + (++FAKE.n), name: t.name, input: t.input }))]; out.stop = r.tools && r.tools.length ? "tool_use" : "end_turn"; }
    if (ui && r.text) ui.text(r.text);
    return r.text || "";
  };
  // one request through the real send(): refine, route, agent or text answer, Undo button, learning
  window.ask = async (q, route, steps) => { FAKE.calls = []; FAKE.route = route; FAKE.queue = steps; input.value = q; await send(); return FAKE.calls.filter((c) => c.who === "main").map((c) => c.model); };
  Math.random = () => 0.5; // no exploration unless a check asks for it
  return true;
})()`;
const FILES = { complexity: "simple", tools: true, parallel: false, compute: false, web: false };
const CHAT = { complexity: "simple", tools: false, parallel: false, compute: false, web: false };
const WEB = { complexity: "simple", tools: false, parallel: false, compute: false, web: true };
const G = "groq/openai/gpt-oss-120b", L = "gemini/gemini-3.1-flash-lite"; // the default fast models, in order

let app;
try {
  fs.mkdirSync(W, { recursive: true });
  app = await openApp({ port: "20241" });
  const E = (js, ms) => app.evaluate(js, ms);
  check("the page loads against a fresh backend", await E(FAKE));
  await E(`(async () => { CFG = { ...CFG, approval: "bypass", cwd: ${J(W)}, roots: [${J(W)}] }; await saveCfg(); LS.set("orc.health", {}); LS.set("orc.recipes", []); return true; })()`);
  const ks = (m, k) => E(`Math.round(kscore(${J(m)}, ${J(k)}) * 100) / 100`);

  // ---- ranking from scores, directly
  check("no scores: the configured order", J(await E(`rank(["A","B","C"], "files")`)) === J(["A", "B", "C"]));
  await E(`noteKind("B", "files", 2)`);
  check("a model that did well on a kind of task moves up for that kind", J(await E(`rank(["A","B","C"], "files")`)) === J(["B", "A", "C"]));
  check("other kinds and requests without a kind keep the configured order", J(await E(`[rank(["A","B","C"], "web"), rank(["A","B","C"])]`)) === J([["A", "B", "C"], ["A", "B", "C"]]));
  await E(`noteKind("A", "files", -1.5)`);
  check("a model that was corrected on a kind moves down for it", J(await E(`rank(["A","B","C"], "files")`)) === J(["B", "C", "A"]));
  check("15% of the time scores are ignored, so other models still get tried", J(await E(`(() => { Math.random = () => 0.1; const r = rank(["A","B","C"], "files"); Math.random = () => 0.5; return r; })()`)) === J(["A", "B", "C"]));
  await E(`(() => { const H = LS.get("orc.health"); H.D = { ev: [], k: { files: [{ t: Date.now() - HLIFE, v: 2 }] } }; H.E = { ev: [], k: { files: [{ t: Date.now() - 6 * HLIFE, v: 2 }] } }; LS.set("orc.health", H); })()`);
  check("scores fade with the same 90-minute half-life", (await ks("D", "files")) === 1 && (await ks("E", "files")) < 0.05, `${await ks("D", "files")} ${await ks("E", "files")}`);
  check("a half-faded score still reorders, a faded one no longer does", J(await E(`rank(["C","D"], "files")`)) === J(["D", "C"]) && J(await E(`rank(["C","E"], "files")`)) === J(["C", "E"]));
  check("the existing penalty still counts", J(await E(`(() => { note("C", 1.5); return rank(["C","F"]); })()`)) === J(["F", "C"]));
  check("a good score never lifts the strong model above the fast ones, but it still takes over from a corrected one", J(await E(`(() => { LS.set("orc.health", {}); noteKind("claude-first", "files", 3); const a = rank([...TIERS.fast, "claude-first"], "files"); noteKind(TIERS.fast[0], "files", -2); return [a, rank([...TIERS.fast, "claude-first"], "files")]; })()`)) === J([[G, L, "claude-first"], [L, "claude-first", G]]));
  check("corrections are recognised, polite openings are not", J(await E(`["no, that's wrong", "That's incorrect", "It doesn't work", "still broken", "You forgot the header", "No, thanks", "no problem, now do the next one", "Nice, now sort the rest"].map((s) => CORRECTION.test(s))`)) === J([true, true, true, true, true, false, false, false]));
  await E(`LS.set("orc.health", {})`);

  // ---- 1. a file request whose actions all worked
  let models = await E(`ask("Write a short notes file called notes.txt in my workspace", ${J(FILES)}, [
    { text: "Writing it.", tools: [{ name: "write_file", input: { path: "notes.txt", content: "PRIVATE-WORDS-4471 hello" } }] },
    { text: "Done: wrote notes.txt." }])`);
  check("the request is routed as a file task and the first fast model works on it", (await E(`TURN.kind`)) === "files" && models[0] === G && fs.existsSync(path.join(W, "notes.txt")), J(models));
  let R = await E(`RCP()`);
  check("a verified request leaves one recipe with the tool steps", R.length === 1 && R[0].steps === "write_file {path: working folder/*.txt, content}" && R[0].kind === "files" && R[0].ok === 1, J(R));
  check("the recipe has no file contents, paths or file names", !/PRIVATE-WORDS|notes\.txt|omnigpt-learning-test|OmniRoute Workspace/i.test(J(R)) && /^Write a short notes file called \*\.txt in my workspace$/.test(R[0].task), R[0] && R[0].task);
  check("the score waits for the next message (a correction would cancel it)", (await ks(G, "files")) === 0);
  const undo1 = await E(`(() => { const b = [...document.querySelectorAll("[data-undo]")].pop(); return b ? { kind: b.dataset.kind, ms: JSON.parse(b.dataset.ms) } : null; })()`);
  check("the Undo button knows the kind of task and who wrote the answer", undo1 && undo1.kind === "files" && undo1.ms[G] === 1, J(undo1));
  await E(`showPane("skills")`);
  const pane = await E(`document.getElementById("s-body").textContent`);
  check("Settings > Skills lists the recipe with its steps", /Recipes/.test(pane) && /called \*\.txt in my workspace/.test(pane) && /write_file \{path: working folder\/\*\.txt, content\}/.test(pane) && /worked 1 time/.test(pane), pane.slice(-300));

  // ---- 2. the next message is not a correction: the file answer counts for the model that wrote it
  models = await E(`ask("Thanks! What is the capital of France?", ${J(CHAT)}, [{ text: "Paris." }])`);
  check("a kept verified answer counts for its model, for that kind only", (await ks(G, "files")) === 1 && (await ks(G, "chat")) === 0 && (await ks(L, "files")) === 0, `${await ks(G, "files")} ${await ks(G, "chat")}`);
  check("chat is its own kind", (await E(`TURN.kind`)) === "chat" && models[0] === G, J(models));

  // ---- 3. a correction lowers the model that wrote the corrected answer, for that kind only
  models = await E(`ask("no, that's wrong", ${J(CHAT)}, [{ text: "Sorry, it is Paris." }])`);
  check("a correction counts against the model for that kind", (await ks(G, "chat")) === -1.5 && (await ks(G, "files")) === 1, `${await ks(G, "chat")} ${await ks(G, "files")}`);
  check("after the correction another model answers this kind first", models[0] === L, J(models));
  check("the corrected model still comes first for the kind it does well", (await E(`rank(TIERS.fast, "files")[0]`)) === G && (await E(`rank(TIERS.fast, "chat")[0]`)) === L);

  // ---- 4. a similar request gets the recipe; it partly fails, so nothing new is learned and the recipe is dropped
  await E(`ask("Write another short notes file called todo.txt in my workspace", ${J(FILES)}, [
    { text: "Writing.", tools: [{ name: "write_file", input: { path: "todo.txt", content: "x" } }, { name: "read_file", input: { path: "missing.txt" } }] },
    { text: "One part failed." }])`);
  const sys4 = await E(`FAKE.calls.filter((c) => c.who === "main").map((c) => c.system)[0] || ""`);
  check("a similar request is offered the recipe as a hint", /A similar request worked before like this[^\n]*\n- "Write a short notes file called \*\.txt in my workspace": write_file \{path: working folder\/\*\.txt, content\}/.test(sys4), (sys4.match(/A similar request[\s\S]{0,200}/) || [""])[0].replace(/\s+/g, " "));
  R = await E(`RCP()`);
  check("a request with a failed action saves no recipe, and the recipe it was offered is dropped", R.length === 0, J(R));
  check("failed actions count against the model for that kind", (await ks(G, "files")) === 0.7, String(await ks(G, "files")));

  // ---- 5. Undo: the answer counts against its model, its recipe is removed, and it is never counted as good
  await E(`ask("Create a plan file called plan.txt in my workspace", ${J(FILES)}, [
    { text: "Creating.", tools: [{ name: "write_file", input: { path: "plan.txt", content: "step one" } }] }, { text: "Created plan.txt." }])`);
  check("the verified request leaves a new recipe", (await E(`RCP().length`)) === 1);
  const undone = await E(`(async () => { const b = [...document.querySelectorAll("[data-undo]")].pop(), box = b.parentNode; b.click(); b.click(); for (let i = 0; i < 50 && b.isConnected; i++) await new Promise((r) => setTimeout(r, 100)); return box.textContent; })()`);
  check("Undo reverses the change", /^Undone: \d+ change/.test(undone) && (process.platform !== "win32" || !fs.existsSync(path.join(W, "plan.txt"))), undone); // a new file goes to the Recycle Bin, which exists on Windows only
  check("Undo counts against the model for that kind", (await ks(G, "files")) === -0.8, String(await ks(G, "files")));
  check("Undo removes the recipe that answer left", (await E(`RCP().length`)) === 0);
  check("an undone answer is not counted as good later", (await E(`PEND`)) === null);
  check("the ranking for file tasks now changes", (await E(`rank(TIERS.fast, "files")[0]`)) === L);
  await E(`ask("Thanks, that's all for now", ${J(CHAT)}, [{ text: "You're welcome." }])`);
  check("the next message adds nothing for the undone answer", (await ks(G, "files")) === -0.8 && (await ks(L, "files")) === 0, `${await ks(G, "files")} ${await ks(L, "files")}`);

  // ---- 6. an empty reply counts against the model that went silent
  models = await E(`ask("What is the newest version of the Node.js runtime today?", ${J(WEB)}, [{ text: "" }, { text: "Version 26, from the release page." }])`);
  check("an empty reply makes the agent ask another model", (await E(`TURN.kind`)) === "web" && J(models) === J([G, L]), J(models));
  check("the silent model loses points for that kind only", (await ks(G, "web")) === -1 && (await ks(L, "web")) === 0 && (await ks(G, "files")) === -0.8, `${await ks(G, "web")} ${await ks(L, "web")}`);

  // ---- Settings > Models shows the per-kind scores
  await E(`showPane("models")`);
  const table = await E(`(() => { const t = document.querySelector("#s-body .stbl"); if (!t) return null; const head = [...t.querySelectorAll("th")].map((x) => x.textContent); const row = [...t.querySelectorAll("tbody tr")].find((r) => r.cells[0].textContent === ${J(G)}); return { head, files: row && row.querySelector("[data-ks=files]").textContent, web: row && row.querySelector("[data-ks=web]").textContent, chat: row && row.querySelector("[data-ks=chat]").textContent }; })()`);
  check("Settings > Models shows a score per kind of task", table && J(table.head) === J(["Model", "Penalty", "Files", "Web", "Chat", "Last problem"]) && table.files === "−0.8" && table.web === "−1.0" && table.chat === "−1.5", J(table));

  // ---- recipes in Settings > Skills can be removed; the list is capped
  await E(`LS.set("orc.recipes", Array.from({ length: 3 }, (_, k) => ({ id: "r" + k, task: "Sort the photos in Pictures by year " + k, kind: "files", steps: "find_files {pattern} → move_files {4 moves}", sig: "s" + k, ok: 1, bad: 0, ts: Date.now() - k })))`);
  await E(`showPane("skills"); document.querySelector("[data-rdel=r1]").click(); true`);
  await new Promise((r) => setTimeout(r, 200));
  check("Remove in Settings > Skills deletes that recipe", J(await E(`RCP().map((r) => r.id)`)) === J(["r0", "r2"]) && !(await E(`!!document.querySelector("[data-rdel=r1]")`)));
  await E(`(() => { TURN = { id: "cap", kind: "files", ok: 1, fail: 0, seq: [] }; for (let k = 0; k < 40; k++) { TURN.seq = ["step_" + k + " {path: workspace}"]; saveRecipe("Do the numbered chore number " + k + " today", "done", true); } return true; })()`);
  check("at most 30 recipes are kept, the newest first", (await E(`RCP().length`)) === 30 && /chore number 39/.test(await E(`RCP()[0].task`)));
  check("a recipe is never saved with something that looks like a secret", await E(`(() => { LS.set("orc.recipes", []); TURN = { id: "s", kind: "files", ok: 1, fail: 0, seq: ["write_file {path: workspace/*.txt, content}"] }; saveRecipe("Save my api key sk-abcdefghijk123 in a file", "done", true); saveRecipe("Write my password into notes", "done", true); return RCP().length === 0; })()`));
  check("shapes keep names, counts, folder kinds and file types only", J(await E(`[shapeOf({ name: "move_files", input: { moves: [{ source: "C:\\\\Users\\\\ada\\\\Downloads\\\\x.pdf", destination: "C:\\\\Users\\\\ada\\\\Downloads\\\\PDF\\\\x.pdf" }, {}, {}] } }), shapeOf({ name: "find_files", input: { pattern: "*.pdf", path: "C:\\\\Users\\\\ada\\\\Downloads" } }), shapeOf({ name: "make_document", input: { path: "C:\\\\Users\\\\ada\\\\Documents\\\\OmniRoute Workspace\\\\Tax 2025.docx", title: "Taxes", content: "# Secret plans" } })]`)) === J(["move_files {3 moves}", "find_files {pattern, path: Downloads}", "make_document {path: workspace/*.docx, title, content}"]));
  check("a request is remembered without its paths, file names or links", (await E(`reqText("Sort C:\\\\Users\\\\ada\\\\Downloads by type, rename report-2024.pdf and check https://example.org/a?token=1\\n\\nAttached files (saved on the user's PC): x")`)) === "Sort Downloads by type, rename *.pdf and check example.org", await E(`reqText("Sort C:\\\\Users\\\\ada\\\\Downloads by type, rename report-2024.pdf and check https://example.org/a?token=1")`));
  check("no errors in the page", app.logs.length === 0, app.logs.join("; ").slice(0, 300));
} catch (e) { check("learning test", false, String(e.stack || e).slice(0, 600)); }
if (app) await app.close();
fs.rmSync(W, { recursive: true, force: true });

// ---- the benchmark harness in its scripted mode: every task passes against a scripted OmniRoute, a broken one fails
try {
  const out = execFileSync(process.execPath, [path.join(here, "bench.mjs"), "--fake", "--quick"], { stdio: "pipe", timeout: 120000 }).toString();
  check("benchmark self-check (scripted OmniRoute)", /All \d+ tasks passed/.test(out) && /BROKEN-FAKE-CAUGHT/.test(out), out.split("\n").filter((l) => /FAIL|passed|BROKEN/.test(l)).join(" | ").slice(0, 400));
} catch (e) { check("benchmark self-check (scripted OmniRoute)", false, (String(e.stdout || "") + String(e.stderr || "")).split("\n").filter((l) => /FAIL|Error|error/.test(l)).join(" | ").slice(0, 600)); }
console.log(failed ? `${failed} check(s) failed.` : "All learning checks passed.");
process.exit(failed ? 1 : 0);
