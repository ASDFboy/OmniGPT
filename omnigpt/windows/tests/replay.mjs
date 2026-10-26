// Built with Claude (Anthropic) - see CREDITS.md
// Your own test set. OmniGPT keeps the requests you really made that had written "done when" statements and never touched
// your files (%LOCALAPPDATA%\OmniRouteChat\kv\orc.cases.json, on this PC only). This script asks each one again, through the
// real OmniGPT page against the OmniRoute you are running, lets a strong model judge the answer against the saved statements,
// and compares with the last saved run, so you can see whether a change made OmniGPT better or worse at what you ask.
// Run from the repository folder:
//   node omnigpt\windows\tests\replay.mjs --list                  the saved requests
//   node omnigpt\windows\tests\replay.mjs --save-baseline         run everything and remember the result as the reference
//   node omnigpt\windows\tests\replay.mjs                         run everything and compare with the reference
//   options: --limit=10  --only=3,5 (numbers from --list)  --timeout=240  --cases=<file>  --baseline=<file>
// PC access is off and the page uses its own throwaway data folder, so nothing of yours is read or changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openApp } from "./pagekit.mjs";

const args = process.argv.slice(2), flag = (f) => args.includes(f), opt = (k) => (args.find((a) => a.startsWith("--" + k + "=")) || "").split("=").slice(1).join("=");
const J = JSON.stringify, LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const casesFile = opt("cases") || path.join(LOCAL, "OmniRouteChat", "kv", "orc.cases.json");
const baseFile = opt("baseline") || path.join(LOCAL, "OmniRouteChat", "replay-baseline.json");
const TIMEOUT = Number(opt("timeout")) || 240;

// pure helpers (also used by the test): which cases to run, and how a run compares with the reference
export function pick(cases, { only, limit } = {}) {
  let L = cases.map((c, i) => ({ ...c, n: i + 1 }));
  if (only && only.length) L = L.filter((c) => only.includes(c.n));
  return limit ? L.slice(-limit) : L;
}
export function compare(now, ref) {
  if (!ref) return { tag: "new", note: "" };
  const d = ref.tokens ? Math.round(((now.tokens - ref.tokens) / ref.tokens) * 100) : 0, tok = Math.abs(d) >= 25 ? ` tokens ${d > 0 ? "+" : ""}${d}%` : "";
  if (ref.pass && !now.pass) return { tag: "REGRESSION", note: "passed before" + tok };
  if (!ref.pass && now.pass) return { tag: "fixed", note: "failed before" + tok };
  return { tag: "same", note: tok.trim() };
}

if (path.basename(process.argv[1] || "") === "replay.mjs") await main(); // importing the file (the test) only loads pick() and compare()

async function main() {
  let cases = []; try { cases = JSON.parse(fs.readFileSync(casesFile, "utf8")); } catch {}
  if (!Array.isArray(cases) || !cases.length) { console.log("No saved requests yet (" + casesFile + "). OmniGPT saves a request after it finishes when it had \"done when\" statements and did not touch your own files."); process.exit(0); }
  const only = opt("only") ? opt("only").split(",").map(Number) : null, run = pick(cases, { only, limit: Number(opt("limit")) || 0 });
  if (flag("--list")) { for (const c of run) console.log(String(c.n).padStart(3) + "  " + (c.verdict || "").padEnd(10) + " " + String(c.q).replace(/\s+/g, " ").slice(0, 110)); process.exit(0); }

  const url = process.env.OMNIROUTE_URL || "http://127.0.0.1:20128";
  const keyFile = path.join(LOCAL, "OmniRouteChat", "omniroute-key.txt");
  const key = process.env.OMNIROUTE_API_KEY || (() => { try { return fs.readFileSync(keyFile, "utf8").trim(); } catch { return ""; } })();
  if (!key) { console.error("No OmniRoute API key. Set OMNIROUTE_API_KEY, or save the key in OmniGPT (Settings > Connection) first."); process.exit(2); }
  try { const r = await fetch(url + "/v1/models", { headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error("HTTP " + r.status); }
  catch (e) { console.error("OmniRoute does not answer at " + url + ": " + (e.message || e) + ". Start OmniGPT first, or set OMNIROUTE_URL."); process.exit(2); }

  let ref = {}; try { ref = JSON.parse(fs.readFileSync(baseFile, "utf8")); } catch {}
  const app = await openApp({ port: "20243", env: { OMNIROUTE_URL: url, OMNIROUTE_API_KEY: key } });
  const E = (js, ms) => app.evaluate(js, ms);
  let regress = 0; const out = {};
  try {
    await E(`(() => {
      LS.set("orc.settings", { ...(LS.get("orc.settings") || {}), learn: false, cases: false });
      window.replayRun = async (q) => {
        newChat(); $("#pc").checked = false; const u0 = USAGE.calls, t0 = USAGE.in + USAGE.out;
        input.value = q; await send(); const m = history[history.length - 1];
        return { answer: String((m && m.content) || "").replace(/\\n*\\[Actions this turn:[^\\]]*\\]\\s*$/, ""), calls: USAGE.calls - u0, tokens: USAGE.in + USAGE.out - t0 };
      };
      window.replayJudge = async (q, criteria, answer) => {
        const msg = "User's request:\\n" + q.slice(0, 3000) + "\\n\\nAcceptance criteria:\\n" + criteria.map((c, i) => (i + 1) + ". " + c).join("\\n") + "\\n\\nActions the agent ran (oldest first):\\n(none recorded; judge the answer itself)\\n\\nFacts checked by the program (measured on the PC):\\n- none (no files were named)\\n\\nThe agent's final answer:\\n" + answer.slice(0, 6000);
        for (const m of [...TIERS.strong, ...TIERS.fast]) {
          const ui = turn("Replay judge");
          try {
            const t = String(await stream({ model: m, system: CHECK_SYS, timeout: 90000, messages: [{ role: "user", content: msg }] }, { ...ui, text: () => {}, think: () => {} }, true)).trim();
            if (/(^|\\n)[\\s*_#>]*PASS\\b/i.test(t) && !/PROBLEMS?\\s*:/i.test(t)) return { pass: true, why: "" };
            const pm = /PROBLEMS?\\s*:\\s*([\\s\\S]+)/i.exec(t); if (pm || /(^|\\n)\\s*(\\d+[.)]|[-*])\\s+\\S/.test(t)) return { pass: false, why: (pm ? pm[1] : t).replace(/\\s+/g, " ").slice(0, 300) };
          } catch (e) {}
        }
        return { pass: null, why: "no judge answered" };
      };
      return true;
    })()`);
    console.log(`OmniGPT replay · ${run.length} saved request${run.length === 1 ? "" : "s"} · OmniRoute at ${url}${Object.keys(ref).length ? " · comparing with the saved reference" : " · no reference yet (use --save-baseline)"}\n`);
    console.log("  #  Result  Compare      Seconds  Calls  Tokens  Request");
    for (const c of run) {
      const t0 = Date.now(); let r = null, v = { pass: null, why: "" };
      const timer = setTimeout(() => E("(ctrl&&ctrl.abort(),true)").catch(() => {}), TIMEOUT * 1000);
      try { r = await E(`replayRun(${J(c.q)})`, (TIMEOUT + 60) * 1000); v = await E(`replayJudge(${J(c.q)}, ${J(c.criteria || [])}, ${J(r.answer)})`, 180000); }
      catch (e) { v = { pass: false, why: "the page failed: " + String(e.message || e).slice(0, 100) }; }
      clearTimeout(timer);
      const now = { pass: v.pass === true, tokens: r ? r.tokens : 0 }, id = c.key || String(c.n), cmp = v.pass === null ? { tag: "n/a", note: v.why } : compare(now, ref[id]);
      if (cmp.tag === "REGRESSION") regress++;
      out[id] = { pass: now.pass, tokens: now.tokens, calls: r ? r.calls : 0, when: new Date().toISOString() };
      console.log(`${String(c.n).padStart(3)}  ${(v.pass === null ? "skip" : v.pass ? "PASS" : "FAIL").padEnd(6)}  ${cmp.tag.padEnd(11)} ${String(Math.round((Date.now() - t0) / 100) / 10).padStart(8)}  ${String(r ? r.calls : 0).padStart(5)}  ${String(now.tokens).padStart(6)}  ${String(c.q).replace(/\s+/g, " ").slice(0, 60)}` + (!v.pass && v.why ? "\n       why: " + v.why : "") + (cmp.note && cmp.tag !== "n/a" ? "   (" + cmp.note + ")" : ""));
    }
    const done = Object.values(out), passed = done.filter((x) => x.pass).length;
    console.log(`\n${passed} of ${done.length} passed${regress ? ` · ${regress} REGRESSION${regress > 1 ? "S" : ""} since the saved reference` : ""}.`);
    if (flag("--save-baseline")) { fs.writeFileSync(baseFile, J({ ...ref, ...out }, null, 2)); console.log("Saved as the reference: " + baseFile); }
  } finally { await app.close(); }
  process.exit(regress ? 1 : 0);
}
