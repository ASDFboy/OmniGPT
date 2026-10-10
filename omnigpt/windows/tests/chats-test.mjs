// Built with Claude (Anthropic) - see CREDITS.md
// Chats are stored one file per chat (kv/chats/<id>.json) with a small index. Checks the move from the old single
// orc.chats file (backup kept, every chat present, a second start changes nothing, an interrupted move finishes), the chat
// endpoints (save, open, rename and move, delete, search inside chats, export, bad ids and missing tokens refused), that
// everything survives a backend restart, and the page itself against a throwaway backend: the chat list, opening a chat,
// saving only that chat, search, the project chat tools, export, delete and delete all, and how long one save takes
// with 300 chats; and that the brain graph draws no frames while it has settled. Run: node chats-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { openApp, src, testPort } from "./pagekit.mjs";

let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra !== "" ? "  " + String(extra).replace(/\s*\n\s*/g, " / ") : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);
const tmps = [];
const mkData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-chatstest-")); tmps.push(d); fs.mkdirSync(path.join(d, "OmniRouteChat", "kv"), { recursive: true }); return d; };
const kvOf = (d) => path.join(d, "OmniRouteChat", "kv"), chatsOf = (d) => path.join(kvOf(d), "chats");

// 300 chats the way 1.0.2 saved them: one array in orc.chats, each with its rendered conversation, history and graph
const T0 = 1700000000000, N = 300;
const mkChat = (i) => ({ id: String(T0 + i), title: "Chat " + i, html: `<div class="msg"><div class="user">question ${i}</div></div><div class="turn final"><div class="body"><p>${"answer text ".repeat(1700)} marker-${i}</p></div></div>`,
  history: [{ role: "user", content: "question number " + i + (i === 7 ? " about the zebra-unicorn migration" : "") }, { role: "assistant", content: "answer " + i + " " + "lorem ipsum ".repeat(200) + (i === 42 ? " the secret word is periwinkle" : "") }],
  graph: { n: ["openai/gpt-5-mini", "output"], l: [["user", "openai/gpt-5-mini"], ["openai/gpt-5-mini", "output"]], lb: {} }, usage: { calls: 1, in: 10, out: 20, cost: 0, unpriced: 1 },
  dir: null, mode: "default", ts: T0 + i * 1000, folder: i % 10 === 3 ? "f1" : null, project: i % 15 === 0 ? "p1" : null });
const OLD = [...Array.from({ length: N }, (_, i) => mkChat(i)), { ...mkChat(900), id: "bad/../id", title: "Odd id" }, null, { ...mkChat(901), history: [{ role: "user", content: [{ type: "text", text: "look at this picture" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }, { role: "assistant", content: "a cat" }] }];
const writeOld = (d) => {
  fs.writeFileSync(path.join(kvOf(d), "orc.chats.json"), J(OLD));
  fs.writeFileSync(path.join(kvOf(d), "orc.settings.json"), J({ workers: 5 }));
  fs.writeFileSync(path.join(kvOf(d), "orc.folders.json"), J([{ id: "f1", name: "Folder one", project: null }]));
  fs.writeFileSync(path.join(kvOf(d), "orc.projects.json"), J([{ id: "p1", name: "Project one" }]));
};

// a backend of our own on a temporary settings folder (like settings-test), started and stopped as needed
const port = testPort("20252"), base = `http://127.0.0.1:${port}`;
async function start(d) {
  const env = { ...process.env, OMNIGPT_PORT: port, LOCALAPPDATA: d, OMNIROUTE_URL: "http://127.0.0.1:9", OMNIROUTE_SCRIPT: path.join(d, "no-omniroute.mjs") };
  delete env.OMNIGPT_PARENT_PID; delete env.OMNIROUTE_API_KEY;
  const p = spawn(process.execPath, [path.join(src, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = ""; p.stdout.on("data", (x) => (out += x)); p.stderr.on("data", (x) => (out += x));
  for (let i = 0; i < 80; i++) { try { const t = await (await fetch(base + "/")).text(); return { p, token: /TOKEN0="([0-9a-f]{16,})"/.exec(t)?.[1], out: () => out }; } catch { await sleep(250); } }
  p.kill(); throw new Error("backend did not start: " + out);
}
const stop = async (s) => { s.p.kill(); for (let i = 0; i < 40 && s.p.exitCode === null && s.p.signalCode === null; i++) await sleep(100); };
const call = async (s, u, body, token = s.token) => { const r = await fetch(base + u, { method: body ? "POST" : "GET", headers: { "x-app-token": token, "content-type": "application/json" }, body: body && J(body) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, ...j }; };
const files = (d) => { try { return fs.readdirSync(chatsOf(d)).filter((f) => f.endsWith(".json") && f !== "_index.json").sort(); } catch { return []; } };
const mtimes = (d) => Object.fromEntries([...files(d), "_index.json"].map((f) => [f, fs.statSync(path.join(chatsOf(d), f)).mtimeMs]));

let s = null, app = null;
const data = mkData();
try {
  // ---- the move from the old single file
  writeOld(data);
  const oldBytes = fs.readFileSync(path.join(kvOf(data), "orc.chats.json"));
  s = await start(data);
  const backup = path.join(kvOf(data), "orc.chats.json.migrated-backup");
  check("the old chats file is kept as a backup, unchanged", fs.existsSync(backup) && fs.readFileSync(backup).equals(oldBytes) && !fs.existsSync(path.join(kvOf(data), "orc.chats.json")));
  let list = await call(s, "/api/chats");
  check("every old chat is in the new list (including an odd id and a picture)", list.ok && list.chats.length === N + 2 && list.chats.some((c) => c.title === "Odd id" && /^[A-Za-z0-9][\w-]*$/.test(c.id)) && list.chats.some((c) => c.q === "look at this picture [image]"), list.chats?.length);
  check("the list is newest first and carries short previews", list.chats[0].id === String(T0 + 901) && list.chats.find((c) => c.id === String(T0 + 7)).q.includes("zebra-unicorn") && list.chats.find((c) => c.id === String(T0 + 5)).last.length <= 200, J(list.chats[2]).slice(0, 200));
  const same = OLD.slice(0, N).every((c) => fs.readFileSync(path.join(chatsOf(data), c.id + ".json"), "utf8") === J(c));
  check("each chat has its own file, identical to the old record", same && files(data).length === N + 2);
  const kvNow = await call(s, "/api/kv");
  check("the settings store no longer carries the chats", !("orc.chats" in kvNow) && kvNow["orc.settings"]?.workers === 5 && Array.isArray(kvNow["orc.folders"]));
  const before = mtimes(data), indexBefore = fs.readFileSync(path.join(chatsOf(data), "_index.json"), "utf8");
  await stop(s); s = await start(data);
  check("a second start changes nothing", J(mtimes(data)) === J(before) && fs.readdirSync(kvOf(data)).filter((f) => /migrated-backup/.test(f)).length === 1 && fs.readFileSync(path.join(chatsOf(data), "_index.json"), "utf8") === indexBefore);
  check("the restarted backend lists the same chats", J((await call(s, "/api/chats")).chats) === J(list.chats));

  // ---- the chat endpoints
  check("the chat list needs the token", (await call(s, "/api/chats", null, "nope")).status === 403 && (await call(s, "/api/chats/save", { chat: { id: "x1", history: [] } }, "nope")).status === 403 && !fs.existsSync(path.join(chatsOf(data), "x1.json")));
  const rec = { id: "abc123", title: "Saved here", html: "<p>hi</p>", history: [{ role: "user", content: "how tall is the eiffel tower" }, { role: "assistant", content: "About 330 m." }], graph: null, usage: {}, mode: "default", ts: Date.now(), folder: null, project: null };
  let r = await call(s, "/api/chats/save", { chat: rec });
  check("save writes one chat and its list entry", r.ok && r.chat.q === "how tall is the eiffel tower" && r.chat.last === "About 330 m." && fs.existsSync(path.join(chatsOf(data), "abc123.json")));
  r = await call(s, "/api/chats/get?id=abc123");
  check("open reads the full record back", r.ok && J(r.chat) === J(rec));
  const evil = ["../evil", "..", "a/b", "a\\b", "", "x".repeat(65), "_index", "con.json", "C:\\x", "%2e%2e", "CON", "nul", "com1", "LPT9"];
  const refused = [];
  for (const id of evil) { const x = await call(s, "/api/chats/save", { chat: { ...rec, id } }); if (x.status === 400 && !x.ok) refused.push(id); }
  const g1 = await call(s, "/api/chats/get?id=" + encodeURIComponent("../orc.settings")), d1 = await call(s, "/api/chats/delete", { ids: [OLD[5].id, "../orc.settings"] });
  check("bad chat ids are refused (no path tricks)", refused.length === evil.length && g1.status === 400 && d1.status === 400 && fs.existsSync(path.join(chatsOf(data), OLD[5].id + ".json")) && fs.existsSync(path.join(kvOf(data), "orc.settings.json")) && !fs.existsSync(path.join(kvOf(data), "evil.json")) && !fs.existsSync(path.join(data, "OmniRouteChat", "evil.json")), refused.length + "/" + evil.length);
  check("a damaged request is refused, not stored", (await fetch(base + "/api/chats/save", { method: "POST", headers: { "x-app-token": s.token }, body: "{not json" })).status === 400);
  r = await call(s, "/api/chats/meta", { items: [{ id: "abc123", title: "Renamed", folder: "f1" }, { id: "nosuchchat", title: "x" }] });
  const onDisk = JSON.parse(fs.readFileSync(path.join(chatsOf(data), "abc123.json"), "utf8"));
  check("rename and move update the list and the chat file", r.ok && r.chats.length === 1 && onDisk.title === "Renamed" && onDisk.folder === "f1" && onDisk.history.length === 2 && (await call(s, "/api/chats")).chats.find((c) => c.id === "abc123").folder === "f1");
  r = await call(s, "/api/chats/search", { q: "zebra-unicorn" });
  check("search finds words inside a conversation", r.ok && r.hits.length === 1 && r.hits[0].id === String(T0 + 7) && /zebra-unicorn/.test(r.hits[0].snip), J(r.hits));
  r = await call(s, "/api/chats/search", { q: "PERIWINKLE secret" });
  const r2 = await call(s, "/api/chats/search", { q: "renamed eiffel" }), r3 = await call(s, "/api/chats/search", { q: "marker-12" });
  check("every word must match, in any case; titles count", r.hits.length === 1 && r.hits[0].id === String(T0 + 42) && r2.hits.length === 1 && r2.hits[0].id === "abc123" && r3.hits.length === 0, J([r.hits, r2.hits, r3.hits]).slice(0, 200));
  r = await call(s, "/api/chats/delete", { ids: ["abc123"] });
  check("delete removes the file, the list entry and search hits", r.ok && !fs.existsSync(path.join(chatsOf(data), "abc123.json")) && !(await call(s, "/api/chats")).chats.some((c) => c.id === "abc123") && (await call(s, "/api/chats/search", { q: "eiffel" })).hits.length === 0);
  r = await call(s, "/api/chats/all");
  check("export returns every chat in full", r.ok && r.chats.length === N + 2 && r.chats.every((c) => c.html && Array.isArray(c.history)) && J(r.chats.find((c) => c.id === String(T0 + 9))) === J(OLD[9]));
  const m0 = mtimes(data);
  r = await call(s, "/api/chats/import", { chats: OLD });
  check("importing the same old chats again changes nothing", r.ok && J(mtimes(data)) === J(m0));
  const newer = { ...OLD[11], title: "Edited in an old window", ts: OLD[11].ts + 5 };
  r = await call(s, "/api/kv", { key: "orc.chats", value: [newer, { ...OLD[12], title: "older copy", ts: OLD[12].ts - 5 }] });
  check("an old window saving orc.chats updates only newer chats", r.ok && !fs.existsSync(path.join(kvOf(data), "orc.chats.json")) && JSON.parse(fs.readFileSync(path.join(chatsOf(data), OLD[11].id + ".json"))).title === "Edited in an old window" && JSON.parse(fs.readFileSync(path.join(chatsOf(data), OLD[12].id + ".json"))).title === "Chat 12");
  // restart survival: the page's token changes, the chats stay
  const old = s.token, keep = (await call(s, "/api/chats")).chats;
  await stop(s); s = await start(data);
  check("chats survive a backend restart; the old token is refused", s.token !== old && (await call(s, "/api/chats", null, old)).status === 403 && J((await call(s, "/api/chats")).chats) === J(keep));
  // a chat file changed while the list was not updated (the backend was stopped between the two writes)
  const f20 = path.join(chatsOf(data), OLD[20].id + ".json"), c20 = JSON.parse(fs.readFileSync(f20));
  await stop(s); s = null;
  fs.writeFileSync(f20, J({ ...c20, title: "Saved just before a crash" })); fs.writeFileSync(path.join(chatsOf(data), "half.json.tmp"), "{\"id\":");
  s = await start(data);
  check("the list catches up with a chat saved just before a crash; half-written files are removed", (await call(s, "/api/chats")).chats.find((c) => c.id === OLD[20].id).title === "Saved just before a crash" && !fs.existsSync(path.join(chatsOf(data), "half.json.tmp")));
  await stop(s); s = null;

  // ---- an interrupted move: some chat files were written, the old file is still there, one chat was saved again since
  const d2 = mkData(); writeOld(d2); fs.mkdirSync(chatsOf(d2), { recursive: true });
  OLD.slice(0, 100).forEach((c) => fs.writeFileSync(path.join(chatsOf(d2), c.id + ".json"), J(c)));
  fs.writeFileSync(path.join(chatsOf(d2), OLD[50].id + ".json"), J({ ...OLD[50], title: "Newer than the old file", ts: OLD[50].ts + 1 }));
  fs.writeFileSync(path.join(chatsOf(d2), OLD[60].id + ".json"), "{damaged");
  fs.writeFileSync(path.join(chatsOf(d2), OLD[70].id + ".json.tmp"), "{\"id\":");
  s = await start(d2);
  list = await call(s, "/api/chats");
  check("an interrupted move finishes on the next start without losing a chat", list.chats.length === N + 2 && fs.existsSync(path.join(kvOf(d2), "orc.chats.json.migrated-backup")) && !fs.existsSync(path.join(kvOf(d2), "orc.chats.json")), list.chats.length);
  check("a chat saved after the interrupted move keeps the newer copy; a damaged one is restored", list.chats.find((c) => c.id === OLD[50].id).title === "Newer than the old file" && fs.readFileSync(path.join(chatsOf(d2), OLD[60].id + ".json"), "utf8") === J(OLD[60]) && !fs.existsSync(path.join(chatsOf(d2), OLD[70].id + ".json.tmp")));
  await stop(s); s = null;
  // an unreadable old file is left alone, and the app still starts
  const d3 = mkData(); fs.writeFileSync(path.join(kvOf(d3), "orc.chats.json"), "{not json at all");
  s = await start(d3);
  check("an unreadable old chats file is left as it is and the app still starts", (await call(s, "/api/chats")).chats.length === 0 && fs.readFileSync(path.join(kvOf(d3), "orc.chats.json"), "utf8") === "{not json at all" && (await call(s, "/api/kv")).ok !== false);
  await stop(s); s = null;

  // ---- the page, against the migrated chats
  app = await openApp({ port: "20251", env: { LOCALAPPDATA: data } });
  const E = (js, ms) => app.evaluate(js, ms);
  // the brain graph in the real page: nothing is drawn while it has settled, every frame while something moves
  await E(`document.body.classList.add("convo"); true`); await sleep(3000);
  await E(`window.__draws = 0; (() => { const c = document.getElementById("brain").getContext("2d"), o = c.clearRect; c.clearRect = function (...a) { window.__draws++; return o.apply(this, a); }; })(); true`);
  await sleep(10000); const idleDraws = await E("window.__draws");
  await E(`window.__draws = 0; Brain.msg("user", "openai/gpt-5-mini"); Brain.busy("openai/gpt-5-mini", true); true`); await sleep(2000);
  const busyDraws = await E("window.__draws");
  await E(`Brain.busy("openai/gpt-5-mini", false); Brain.reset(); document.body.classList.remove("convo"); true`);
  check("in the page, a settled brain graph draws nothing in 10 idle seconds", idleDraws === 0, idleDraws + " frames (1.0.2 drew about 300)");
  check("in the page, a busy node animates at the full rate", busyDraws >= 30, busyDraws + " frames in 2 s");
  const pageList = await E(`({ n: CHATS.length, rows: document.querySelectorAll("#chats .ci").length, html: CHATS.some((c) => "html" in c || "history" in c) })`);
  check("the page loads only the chat list at start", pageList.n === N + 2 && pageList.rows === N + 2 && !pageList.html, J(pageList));
  const kvSize = (await (await fetch(app.base + "/api/kv", { headers: { "x-app-token": await E("TOKEN") } })).text()).length;
  await E(`openChat(${J(OLD[33].id)})`);
  const opened = await E(`({ id: chatId, n: history.length, marker: col.innerHTML.includes("marker-33"), rows: document.querySelector("#chats .ci.on")?.dataset.id })`);
  check("opening a chat loads its full record", opened.id === OLD[33].id && opened.n === 2 && opened.marker && opened.rows === OLD[33].id, J(opened));
  const m1 = mtimes(data);
  await E(`history = [...history, { role: "user", content: "one more question about otters" }]; saveChat(""); chatFlush()`);
  const m2 = mtimes(data), changed = Object.keys(m2).filter((f) => m2[f] !== m1[f]);
  const saved = JSON.parse(fs.readFileSync(path.join(chatsOf(data), OLD[33].id + ".json"), "utf8"));
  check("saving writes only that chat and the list", J(changed.sort()) === J([OLD[33].id + ".json", "_index.json"].sort()) && saved.history.length === 3 && saved.html.includes("marker-33") && !fs.existsSync(path.join(kvOf(data), "orc.chats.json")), J(changed));
  // how long one save takes with 300 chats: from saveChat() until the chat is on disk
  const times = await E(`(async () => { const t = []; for (let k = 0; k < 7; k++) { const a = performance.now(); saveChat(""); await chatFlush(); t.push(performance.now() - a); } return t.sort((a, b) => a - b); })()`);
  const med = times[3];
  check("one save with 300 chats is quick", med < 500, `median ${med.toFixed(1)} ms (7 saves: ${times.map((x) => x.toFixed(0)).join(", ")}); start-up store ${(kvSize / 1024).toFixed(1)} KB`);
  // search in the sidebar finds words inside chats
  await E(`(() => { const s = document.getElementById("csearch"); s.value = "periwinkle"; s.dispatchEvent(new Event("input")); })()`);
  let found = ""; for (let k = 0; k < 40 && !found; k++) { await sleep(100); found = await E(`[...document.querySelectorAll("#chats .ci")].map((e) => e.dataset.id + ":" + e.textContent).join("|")`); if (/Searching/.test(found) || !found) found = ""; }
  check("the sidebar search finds text inside a chat", found.startsWith(OLD[42].id + ":Chat 42") && /periwinkle/.test(found) && !found.includes("|"), found.slice(0, 120));
  await E(`(() => { const s = document.getElementById("csearch"); s.value = "otters"; s.dispatchEvent(new Event("input")); })()`);
  found = ""; for (let k = 0; k < 40 && !/otters/.test(found); k++) { await sleep(100); found = await E(`document.getElementById("chats").textContent`); }
  check("search finds what was just saved", /Chat 33/.test(found) && /otters/.test(found), found.slice(0, 100));
  await E(`(() => { const s = document.getElementById("csearch"); s.value = ""; s.dispatchEvent(new Event("input")); })()`);
  // the project chat tools, through the real agent loop with a fake model
  await E(`(() => { window.FAKE = { calls: [], q: [], n: 0 };
    stream = async (a, ui, noThink, out) => { FAKE.calls.push({ system: String(a.system || ""), messages: JSON.parse(JSON.stringify(a.messages || [])) });
      if (/You review ONE action/.test(a.system || "")) return '{"verdict":"safe","risk":"low","reason":"ok"}';
      const r = FAKE.q.shift() || { text: "done" };
      if (out) { out.content = [...(r.text ? [{ type: "text", text: r.text }] : []), ...(r.tools || []).map((t) => ({ type: "tool_use", id: "tu" + (++FAKE.n), name: t.name, input: t.input }))]; out.stop = r.tools ? "tool_use" : "end_turn"; }
      return r.text || ""; };
    return true; })()`);
  const tools = await E(`(async () => { newChat(); curProject = "p1"; FAKE.q = [{ tools: [{ name: "list_project_chats", input: {} }, { name: "read_project_chat", input: { id: ${J(OLD[15].id)} } }, { name: "read_project_chat", input: { id: ${J(OLD[16].id)} } }] }, { text: "ok" }];
    ctrl = new AbortController(); busy = true; TURN = { id: uid(), untrusted: false, tok: 0, ok: 0, fail: 0, written: [], t0: Date.now() }; trace = mkTrace();
    try { await agent("what did we decide in this project?", [{ role: "user", content: "what did we decide in this project?" }], ["fake/main-model"]); } finally { trace.finish(); busy = false; ctrl = null; }
    const last = FAKE.calls.filter((c) => !/You review ONE action/.test(c.system)).pop().messages.pop().content.filter((b) => b.type === "tool_result").map((b) => typeof b.content === "string" ? b.content : JSON.stringify(b.content));
    return { sys: FAKE.calls[0].system, res: last }; })()`);
  const projIds = OLD.slice(0, N).filter((c) => c.project === "p1").map((c) => c.id);
  check("the agents are told about the project's other chats", tools.sys.includes(`[${OLD[30].id}] Chat 30: answer 30 lorem ipsum`), (tools.sys.match(/Other conversations[^\n]*\n[^\n]*/) || [""])[0].slice(0, 160));
  check("list_project_chats lists the project's chats", projIds.every((id) => tools.res[0].includes(`[${id}]`)) && !tools.res[0].includes(`[${OLD[16].id}]`), tools.res[0].slice(0, 80));
  check("read_project_chat reads a chat from disk", /<chat_transcript untrusted="true">\nUSER: question number 15\n\nASSISTANT: answer 15/.test(tools.res[1] || ""), (tools.res[1] || "").slice(0, 90));
  check("read_project_chat refuses chats outside the project", tools.res[2] === "No such conversation in this project.", tools.res[2]);
  await E(`curProject = null`);
  // export everything, and one chat as Markdown
  await E(`window.__blobs = []; URL.createObjectURL = (b) => { window.__blobs.push(b); return "blob:x"; }; HTMLAnchorElement.prototype.click = function () {}; true`);
  await E(`showPane("data"); document.getElementById("s-export").click(); true`);
  let exp = null; for (let k = 0; k < 50 && !exp; k++) { await sleep(100); exp = await E(`window.__blobs.length ? window.__blobs[0].text() : null`); }
  const ex = exp ? JSON.parse(exp) : {};
  check("export includes every chat in full, with folders and projects", ex.chats?.length === N + 2 && ex.chats.every((c) => c.html && c.history) && ex.chats.find((c) => c.id === OLD[33].id).history.length === 3 && ex.folders?.length === 1 && ex.projects?.length === 1, ex.chats?.length);
  await E(`window.__blobs = []; exportChat(${J(OLD[42].id)})`);
  const md = await E(`window.__blobs[0] ? window.__blobs[0].text() : ""`);
  check("one chat exports as Markdown", /^# Chat 42/.test(md) && /## You\n\nquestion number 42/.test(md) && /periwinkle/.test(md), md.slice(0, 60));
  // rename, move, delete a folder, delete a chat: the list on disk follows
  await E(`chatMeta([{ id: ${J(OLD[1].id)}, title: "Better title" }]); moveChat(${J(OLD[2].id)}, "f1", null); delGrp("folder", "f1"); delChat(${J(OLD[4].id)}); chatFlush()`);
  const disk = Object.fromEntries((await (await fetch(app.base + "/api/chats", { headers: { "x-app-token": await E("TOKEN") } })).json()).chats.map((c) => [c.id, c]));
  check("rename, move and folder delete reach the list on disk", disk[OLD[1].id].title === "Better title" && disk[OLD[2].id].folder === null && disk[OLD[3].id].folder === null && JSON.parse(fs.readFileSync(path.join(chatsOf(data), OLD[13].id + ".json"))).folder === null);
  check("delete removes the chat's file", !disk[OLD[4].id] && !fs.existsSync(path.join(chatsOf(data), OLD[4].id + ".json")) && (await E(`!CHATS.some((c) => c.id === ${J(OLD[4].id)})`)));
  // the list survives reloading the page
  await E(`location.reload(); true`); await sleep(500);
  let n2 = 0; for (let k = 0; k < 60 && !n2; k++) { await sleep(250); try { n2 = await E(`typeof KVOK !== "undefined" && KVOK ? CHATS.length : 0`); } catch {} }
  check("after a reload the page shows the same chats", n2 === N + 1 && (await E(`CHATS.find((c) => c.id === ${J(OLD[1].id)}).title`)) === "Better title", n2);
  // delete all chats: every chat file and the backups of the old file are removed
  await E(`ask = () => Promise.resolve(true); showPane("data"); document.getElementById("s-wipe").click(); true`);
  let left = -1; for (let k = 0; k < 50 && left !== 0; k++) { await sleep(100); left = files(data).length; }
  check("delete all removes every chat file and the old backups", left === 0 && (await E(`CHATS.length`)) === 0 && (await E(`document.querySelectorAll("#chats .ci").length`)) === 0 && !fs.readdirSync(kvOf(data)).some((f) => /^orc\.chats/.test(f)) && fs.existsSync(path.join(kvOf(data), "orc.settings.json")), left);
  check("no errors in the page", app.logs.length === 0, app.logs.join("; ").slice(0, 300));
} catch (e) { check("chats test", false, String(e.stack || e).slice(0, 600)); }
if (app) await app.close();
if (s) await stop(s);
for (const d of tmps) { for (let i = 0; i < 10; i++) { try { fs.rmSync(d, { recursive: true, force: true }); break; } catch { await sleep(300); } } }
console.log(failed ? `${failed} check(s) failed.` : "All chat storage checks passed.");
process.exit(failed ? 1 : 0);
