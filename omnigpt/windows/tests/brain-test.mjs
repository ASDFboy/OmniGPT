// Brain graph: runs app/brain.js against a stand-in canvas (strict like a real one: non-finite numbers and negative radii
// throw) and checks that every visible node is drawn with a text label, whatever the graph is fed.
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
const labels = []; let frames = [];
const ctx = {
  setTransform() {}, clearRect() {}, beginPath() {}, moveTo: fin, lineTo: fin, stroke() {}, fill() {},
  quadraticCurveTo: fin, bezierCurveTo: fin,
  arc(x, y, r) { fin(x, y, r); if (r < 0) throw new RangeError("negative radius"); },
  createRadialGradient(...a) { fin(...a); return { addColorStop() {} }; },
  fillText(t, x, y) { if (typeof t !== "string") throw new TypeError("label is not text"); fin(x, y); labels.push(t); },
  set globalAlpha(v) { fin(v); }, get globalAlpha() { return 1; },
};
const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ width: 380, height: 700 }), width: 0, height: 0, offsetParent: {}, parentElement: {} };
const sandbox = {
  document: { getElementById: () => canvas, documentElement: {} },
  getComputedStyle: () => ({ getPropertyValue: () => "#d6d6d6" }),
  window: { devicePixelRatio: 1 }, performance: { now: () => Date.now() },
  requestAnimationFrame: (f) => frames.push(f),
  ResizeObserver: class { constructor(cb) { this.cb = cb; } observe() { this.cb(); } },
  Math, Date, JSON, Object, Array, String, Number, Set, Map, RegExp, console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(src, "brain.js"), "utf8") + "\nglobalThis.Brain=Brain;", sandbox);
const B = sandbox.Brain;
let t = 1000;
const run = (n = 30) => { for (let i = 0; i < n; i++) { const F = frames; frames = []; t += 50; labels.length = 0; F.forEach((f) => f(t)); } };

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
console.log(failed ? `${failed} check(s) failed.` : "All brain graph checks passed.");
process.exit(failed ? 1 : 0);
