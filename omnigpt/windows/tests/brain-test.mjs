// Brain graph: runs app/brain.js against a stand-in canvas (strict like a real one: non-finite numbers and negative radii
// throw) and checks that every visible node is drawn with a text label, whatever the graph is fed, and that frames are
// only drawn while the picture changes (fake clock, timers, focus, visibility, resize and theme events).
// Run: node brain-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };

const fin = (...a) => { for (const v of a) if (typeof v !== "number" || !Number.isFinite(v)) throw new TypeError("non-finite value"); };
const labels = []; let frames = [], draws = 0, ops = [], lastOps = [];
const rec = (...a) => ops.push(a.map((v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v)).join(" "));
const ctx = {
  setTransform() {}, clearRect() { draws++; lastOps = ops; ops = []; labels.length = 0; }, beginPath() {}, moveTo(...a) { fin(...a); rec("M", ...a); }, lineTo(...a) { fin(...a); rec("L", ...a); }, stroke() { rec("S"); }, fill() { rec("F"); },
  quadraticCurveTo(...a) { fin(...a); rec("Q", ...a); }, bezierCurveTo(...a) { fin(...a); rec("C", ...a); },
  arc(x, y, r) { fin(x, y, r); if (r < 0) throw new RangeError("negative radius"); rec("A", x, y, r); },
  createRadialGradient(...a) { fin(...a); return { addColorStop(o, c) { rec("G", o, c); } }; },
  fillText(t, x, y) { if (typeof t !== "string") throw new TypeError("label is not text"); fin(x, y); labels.push(t); rec("T", t, x, y); },
  set globalAlpha(v) { fin(v); rec("a", v); }, get globalAlpha() { return 1; },
  set strokeStyle(v) { rec("s", typeof v === "string" ? v : "gradient"); }, set fillStyle(v) { rec("f", typeof v === "string" ? v : "gradient"); }, set font(v) { rec("font", v); },
};
// events the graph listens to, so the test can fire them
const on = {}, listen = (where) => (type, f) => { (on[where + ":" + type] ||= []).push(f); }, fire = (where, type) => (on[where + ":" + type] || []).forEach((f) => f({ type }));
let fg = "#d6d6d6", hasFocus = true, resized = null; const mutations = [], media = [];
const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ width: 380, height: 700 }), width: 0, height: 0, offsetParent: {}, parentElement: {}, addEventListener: listen("canvas") };
const doc = { getElementById: () => canvas, documentElement: {}, body: {}, hidden: false, hasFocus: () => hasFocus, addEventListener: listen("document") };
let t = 1000; const timers = []; let tid = 0;
const sandbox = {
  document: doc,
  getComputedStyle: () => ({ getPropertyValue: () => fg }),
  window: { devicePixelRatio: 1 }, performance: { now: () => t },
  requestAnimationFrame: (f) => frames.push(f),
  setTimeout: (f, ms) => { timers.push({ f, at: t + ms, id: ++tid }); return tid; }, clearTimeout: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
  addEventListener: listen("window"),
  matchMedia: (q) => { const m = { q, ls: [], addEventListener(_, f) { this.ls.push(f); }, removeEventListener(_, f) { this.ls = this.ls.filter((x) => x !== f); } }; media.push(m); return m; },
  MutationObserver: class { constructor(cb) { mutations.push(cb); } observe() {} },
  ResizeObserver: class { constructor(cb) { resized = cb; } observe() { this.cb = resized; resized(); } },
  Math, Date, JSON, Object, Array, String, Number, Set, Map, RegExp, console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(src, "brain.js"), "utf8") + "\nglobalThis.Brain=Brain;", sandbox);
const B = sandbox.Brain;
// one fake 50 ms step: due timers fire, then the requested animation frames run
const run = (n = 30) => { for (let i = 0; i < n; i++) { t += 50; for (const x of timers.filter((x) => x.at <= t)) { sandbox.clearTimeout(x.id); x.f(); } const F = frames; frames = []; F.forEach((f) => f(t)); } }; // labels: those of the last frame drawn
const drawsIn = (ms) => { const a = draws; run(Math.round(ms / 50)); return draws - a; };

run(3);
// the bug from 1.0.2: plan() passed array indexes as labels, so "safety check" got the label 1 and drawing stopped there
B.turn(); B.plan(["openai/gpt-5-mini", "guard"]); B.msg("user", "openai/gpt-5-mini"); B.msg("openai/gpt-5-mini", "guard"); B.msg("guard", "output");
run();
check("plan() keeps real labels", labels.includes("safety check") && labels.includes("gpt 5 mini") && labels.includes("answer"), labels.join(","));
check("no drawing errors", B.errors === 0, "errors=" + B.errors);
// chats saved by 1.0.2 may carry the bad label
B.reset(); B.restore({ n: ["guard", "output", "openai/gpt-5-mini"], l: [["user", "openai/gpt-5-mini"], ["x", "y"], "junk"], lb: { guard: 1, output: {} } }); run();
check("old saved chats with bad labels draw normally", B.errors === 0 && labels.includes("safety check") && labels.includes("answer"), labels.join(","));
// missing names never become nodes
B.msg(undefined, "output"); B.msg("user", null); B.msg("user", ""); B.ok("undefined"); run();
check("missing names are ignored", !labels.some((l) => /^(undefined|null)$/.test(l)) && !B.snapshot().n.some((k) => /^(undefined|null)?$/.test(k)), B.snapshot().n.join(","));
// random use: every visible node keeps drawing
const K = ["user", "output", "guard", "sandbox", "openai/gpt-5-mini", "W1", "W2", "t:read_file", "t:move_files", "mem:a", "skill:x", "file:c:\\a\\b.png", undefined, ""];
const pick = () => K[Math.floor(Math.random() * K.length)];
for (let i = 0; i < 3000; i++) {
  const r = Math.random();
  if (r < .35) B.msg(pick(), pick()); else if (r < .45) B.ok(pick()); else if (r < .5) B.fail(pick()); else if (r < .55) B.busy(pick(), r < .52);
  else if (r < .6) B.plan([pick(), pick()]); else if (r < .65) B.ctx("mem:a", r < .62 ? 7 : "memory: x"); else if (r < .7) { B.ready(); B.feed(pick()); }
  else if (r < .73) B.files(["C:\\x\\" + (i % 3) + ".png"]); else if (r < .8) B.turn(); else if (r < .82) { const g = JSON.parse(JSON.stringify(B.snapshot())); B.reset(); B.restore(g); }
  if (i % 20 === 0) run(2);
}
run(60);
const visible = B.snapshot().n.length + 1;
check("3000 random graph updates: no drawing errors", B.errors === 0, "errors=" + B.errors);
check("every visible node has a label", labels.length >= visible, `${labels.length} label lines for ${visible} nodes`);

// ---- frames are only drawn while the picture changes
K.forEach((k) => B.busy(k, false)); run(1000); // 50 s later: the random run's nodes have stopped moving and its links have faded
const idle = drawsIn(10000);
check("a settled graph draws no frames in 10 idle seconds", idle === 0 && frames.length === 0 && timers.length === 0, `${idle} frames (drawn all the time this would be 200 at the test's 20 steps a second)`);
B.reset(); B.turn(); B.plan(["openai/gpt-5-mini"]); B.msg("user", "openai/gpt-5-mini"); B.msg("openai/gpt-5-mini", "guard"); B.msg("guard", "output");
const busy1 = drawsIn(1000);
check("while signals travel every step draws a frame", busy1 === 20, busy1 + " frames in 1 s");
B.busy("openai/gpt-5-mini", true);
const busy2 = drawsIn(5000);
check("a busy node keeps animating at the full rate", busy2 === 100, busy2 + " frames in 5 s");
B.busy("openai/gpt-5-mini", false); run(100);
const fading = drawsIn(10000);
check("while links only fade out, about one frame a second", fading >= 8 && fading <= 12, fading + " frames in 10 s");
run(700);
const idle2 = drawsIn(10000);
check("after the links have faded: no frames in 10 idle seconds", idle2 === 0 && frames.length === 0 && timers.length === 0, idle2 + " frames");
// the picture it stops on is the one it would keep drawing
B.restore({ n: ["openai/gpt-5-mini", "guard", "output"], l: [["user", "openai/gpt-5-mini"], ["openai/gpt-5-mini", "guard"], ["guard", "output"]] }); run(200);
const settled = drawsIn(5000), stopped = ops.join("|");
fire("canvas", "pointerenter"); const more = drawsIn(500);
check("pointing at the graph wakes it for a frame", more === 1, more + " frames");
check("the settled picture is exactly what continued drawing shows", settled === 0 && stopped === ops.join("|") && ops.length > 20, `${ops.length} drawing steps`);
// hidden window: nothing is drawn and no frames are requested; visible again: drawing resumes
doc.hidden = true; fire("document", "visibilitychange");
B.msg("user", "output"); B.busy("output", true);
const hid = drawsIn(5000);
check("a hidden window draws nothing, even while busy", hid === 0 && frames.length === 0 && timers.length === 0, hid + " frames");
doc.hidden = false; fire("document", "visibilitychange");
const back = drawsIn(1000);
check("visible again: drawing resumes at once", back === 20, back + " frames in 1 s");
// not focused: moving parts twice a second; focused again: the full rate
hasFocus = false; fire("window", "blur"); run(2);
const unf = drawsIn(5000);
check("a window without focus shows moving parts twice a second", unf >= 9 && unf <= 11, unf + " frames in 5 s");
hasFocus = true; fire("window", "focus");
const foc = drawsIn(1000);
check("focused again: the full rate", foc >= 19, foc + " frames in 1 s");
B.busy("output", false); run(1000);
// a settled graph wakes up for resizes, theme changes and screen scaling
const d0 = draws; resized(); run(5);
check("a resize redraws the settled graph", draws - d0 === 1, draws - d0 + " frames");
fg = "#202020"; mutations.forEach((cb) => cb([])); run(5);
check("a theme change redraws it in the new colour", ops.concat(lastOps).some((o) => /rgba\(32,32,32/.test(o)) && timers.length === 0 && frames.length === 0);
sandbox.window.devicePixelRatio = 2; media.filter((m) => /resolution/.test(m.q)).forEach((m) => m.ls.forEach((f) => f())); run(5);
check("moving to a screen with other scaling resizes the canvas", canvas.width === 760 && canvas.height === 1400, canvas.width + "x" + canvas.height);
// scaling noticed while drawing (no media event): the canvas resizes and there is still only one frame loop
B.busy("output", true); run(5); sandbox.window.devicePixelRatio = 1; let most = 0, d1 = draws;
for (let i = 0; i < 20; i++) { run(1); most = Math.max(most, frames.length); }
check("a scaling change while animating keeps a single frame loop", canvas.width === 380 && most === 1 && draws - d1 === 20, `width ${canvas.width}, ${most} frames waiting, ${draws - d1} drawn in 1 s`);
B.busy("output", false);
check("still no drawing errors", B.errors === 0, "errors=" + B.errors);
console.log(failed ? `${failed} check(s) failed.` : "All brain graph checks passed.");
process.exit(failed ? 1 : 0);
