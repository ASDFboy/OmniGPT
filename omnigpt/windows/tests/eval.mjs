// Small accuracy check: one free-model answer vs a vote of 3 vs the strong model, on questions with exact answers.
// Run: node eval.mjs   (needs OMNIROUTE_API_KEY in the environment; makes about 75 model calls, 15 of them to the strong model)
const KEY = process.env.OMNIROUTE_API_KEY;
const URL = "http://127.0.0.1:20128/v1/messages";
const FAST = "groq/openai/gpt-oss-120b", LITE = "gemini/gemini-3.1-flash-lite", STRONG = process.argv.includes("--no-strong") ? null : "claude-first";
const TASKS = [
  ["How many times does the letter r appear in the words 'strawberry raspberry' combined?", "6"],
  ["A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How many cents does the ball cost?", "5"],
  ["Alice has 3 brothers and 2 sisters. How many sisters does one of Alice's brothers have?", "3"],
  ["How many squares of any size are on a standard 8x8 chessboard?", "204"],
  ["How many integers from 1 to 1000 are divisible by 3 or 5 but not by 15?", "401"],
  ["What is the remainder when 7^100 is divided by 13?", "9"],
  ["How many trailing zeros does 100! have?", "24"],
  ["A train leaves at 14:50 and arrives at 03:25 the next day. How many minutes does the trip take?", "755"],
  ["How many times does the letter e appear in 'nevertheless excellence'?", "8"],
  ["How many distinct arrangements are there of the letters in BANANA?", "60"],
  ["What is the 2026th digit after the decimal point of 1/7?", "8"],
  ["If you write out all the integers from 1 to 100, how many times do you write the digit 9?", "20"],
  ["What is the sum of the digits of 2^50?", "76"],
  ["January 1, 2024 was a Monday. What day of the week was December 25, 2024?", "wednesday"],
  ["Which number is larger, 9.11 or 9.9?", "9.9"],
];
const SYS = "Answer the question. Think briefly, then end with a final line exactly in the form: ANSWER: <answer>";
const norm = (s) => String(s || "").split("=").pop().toLowerCase().replace(/[*_`$°,]/g, "").replace(/\b(degrees?|cents?|minutes?|times?|zeros?|arrangements?)\b/g, "").replace(/\.$/, "").trim();
async function ask(model, q) {
  try {
    const r = await fetch(URL, { method: "POST", headers: { "x-api-key": KEY, "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, system: SYS, max_tokens: 1500, messages: [{ role: "user", content: q }] }), signal: AbortSignal.timeout(90000) });
    const j = await r.json(); const t = (j.content || []).map((b) => b.text || "").join("");
    const m = /ANSWER:\s*(.+)/i.exec(t); return m ? norm(m[1]) : null;
  } catch { return null; }
}
const vote = (a) => { const c = {}; for (const x of a) if (x) c[x] = (c[x] || 0) + 1; const top = Object.entries(c).sort((p, q) => q[1] - p[1])[0]; return top ? { ans: top[0], agree: top[1] } : { ans: null, agree: 0 }; };
const score = { one: 0, vote3: 0, lite: 0, strong: 0, unanimous: 0, unanimousRight: 0 };
for (const [q, want] of TASKS) {
  const [s1, s2, s3, l, st] = await Promise.all([ask(FAST, q), ask(FAST, q), ask(FAST, q), ask(LITE, q), STRONG ? ask(STRONG, q) : null]);
  const v = vote([s1, s2, s3]); const ok = (x) => x === want;
  score.one += ok(s1); score.vote3 += ok(v.ans); score.lite += ok(l); score.strong += ok(st);
  if (v.agree === 3) { score.unanimous++; score.unanimousRight += ok(v.ans); }
  console.log(`${ok(v.ans) ? "ok  " : "MISS"} want=${want.padEnd(9)} 120b=[${s1},${s2},${s3}] lite=${l} strong=${st}  ${q.slice(0, 50)}`);
}
const n = TASKS.length, pct = (x) => Math.round((100 * x) / n) + "%";
console.log(`\n120b single: ${pct(score.one)}   120b vote of 3: ${pct(score.vote3)}   flash lite: ${pct(score.lite)}   strong: ${STRONG ? pct(score.strong) : "skipped"}`);
console.log(`All 3 samples agreed on ${score.unanimous}/${n}; those were right ${score.unanimousRight}/${score.unanimous}. Disagreement is the escalation signal.`);
