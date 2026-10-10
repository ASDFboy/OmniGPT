// Built with Claude (Anthropic) - see CREDITS.md
// Account connections: saved links and keys never reach the page or the model (DPAPI on Windows), send_message always
// asks and posts the right JSON to Discord and Slack, calendars (ICS) are read with repeats and time zones, http_request
// adds a saved key only for its own address, and the github tool runs only allowed gh commands (a fake gh stands in).
// Also checks the backend's /api/connections endpoints and the Settings > Accounts pane in the real page.
// Run: node connections-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.TZ = "Etc/UTC"; // the calendar checks compare clock times
const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-conntest-"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-conntest-gh-"));
process.env.LOCALAPPDATA = data;
process.env.OMNIGPT_TEST_ALLOW_LOCAL = "1";
process.env.OMNIGPT_TEST_SECRET_TOKEN = "zzz-must-not-reach-gh"; // a secret-looking variable: programs the agents start never get it
// a stand-in for the GitHub CLI: prints what it was given (and fake tokens, which must be hidden)
const fakeGh = path.join(tmp, "fake-gh.mjs");
fs.writeFileSync(fakeGh, [
  'import fs from "node:fs"; import path from "node:path";',
  "const a = process.argv.slice(2);",
  'if (a[0] === "auth" && a[1] === "status") { console.log("github.com\\n  \\u2713 Logged in to github.com account octo-test (keyring)\\n  - Token: gho_************************************"); process.exit(0); }',
  'if (a[0] === "repo" && a[1] === "clone") { fs.mkdirSync(a[3], { recursive: true }); fs.writeFileSync(path.join(a[3], "README.md"), "# hello"); }',
  "console.log(JSON.stringify({ args: a, cwd: process.cwd(), prompt: process.env.GH_PROMPT_DISABLED || null, color: process.env.NO_COLOR || null, notifier: process.env.GH_NO_UPDATE_NOTIFIER || null, leaked: process.env.OMNIGPT_TEST_SECRET_TOKEN || null }));",
  'console.log("token: gho_" + "A".repeat(36) + " pat: github_pat_11ABCDEFG0_" + "x".repeat(40));',
].join("\n"));
process.env.OMNIGPT_GH = fakeGh;
const tools = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
const C = await import(pathToFileURL(path.join(src, "connections.mjs")).href);
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-conn-test-" + process.pid);
const win = process.platform === "win32";
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const cfg = { ...tools.loadConfig(), cwd: W, roots: [path.dirname(W)], granted: [], approval: "ask" };
const refused = (name, input, c = cfg) => tools.precheck(name, input, c).then(() => "", (e) => e.message);
const R = (name, input, meta) => tools.run(name, input, cfg, undefined, meta);
const fails = (p) => p.then(() => "", (e) => e.message);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0"), iso = (t) => (t === undefined ? "" : new Date(t).toISOString().slice(0, 16));
const ld = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const S = { discord: "discordSECRETtoken_ABCDEFGHIJKLMNOP", slack: "slackSECRETtokenXYZ0123456789", cal: "calSECRETkey9876543210", api: "apiSECRET_0123456789abcdef", gone: "goneSECRETtoken_QRSTUVWXYZ012345", priv: "privSECRETtoken_1234567890abcd", srv: "srvSECRETtoken_ABCDEFGHIJKLMNOP", srvApi: "srvAPIsecret_0123456789abcdef", page: "pageSECRETtoken_ABCDEFGHIJKLMNO" };
const leaks = (t) => Object.values(S).filter((x) => String(t).includes(x));
const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OmniGPT test//EN",
  "BEGIN:VTIMEZONE", "TZID:W. Europe Standard Time",
  "BEGIN:STANDARD", "DTSTART:16010101T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10", "END:STANDARD",
  "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3", "END:DAYLIGHT", "END:VTIMEZONE",
  "BEGIN:VEVENT", "UID:standup-1", "DTSTART:20261012T090000Z", "DTEND:20261012T093000Z", "SUMMARY:Team standup", "LOCATION:Room 4\\, second floor",
  "DESCRIPTION:Agenda:\\nUpdates\\nBlockers and a long line that is folded", "  across two lines",
  "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder SHOULD NOT APPEAR", "TRIGGER:-PT15M", "END:VALARM", "END:VEVENT",
  "BEGIN:VEVENT", "UID:holiday-1", "DTSTART;VALUE=DATE:20261013", "DTEND;VALUE=DATE:20261014", "SUMMARY:Company holiday", "END:VEVENT",
  "BEGIN:VEVENT", "UID:ny-1", "DTSTART;TZID=America/New_York:20261014T090000", "DTEND;TZID=America/New_York:20261014T093000", "SUMMARY:Call with New York", "END:VEVENT",
  "BEGIN:VEVENT", "UID:weekly-1", "DTSTART;TZID=America/New_York:20261026T100000", "DTEND;TZID=America/New_York:20261026T110000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "EXDATE;TZID=America/New_York:20261028T100000", "SUMMARY:Planning", "END:VEVENT",
  "BEGIN:VEVENT", "UID:daily-1", "DTSTART:20261101T120000Z", "DTEND:20261101T121500Z", "RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261107T120000Z", "SUMMARY:Water the plants", "END:VEVENT",
  "BEGIN:VEVENT", "UID:berlin-1", 'DTSTART;TZID="W. Europe Standard Time":20261020T150000', 'DTEND;TZID="W. Europe Standard Time":20261020T160000', "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Berlin sync", "END:VEVENT",
  "BEGIN:VEVENT", "UID:monthly-1", "DTSTART;VALUE=DATE:20260131", "RRULE:FREQ=MONTHLY;COUNT=4", "SUMMARY:Month end", "END:VEVENT",
  "BEGIN:VEVENT", "UID:monthly-2", "DTSTART:20260113T170000Z", "DTEND:20260113T180000Z", "RRULE:FREQ=MONTHLY;BYDAY=2TU;UNTIL=20260501T000000Z", "SUMMARY:Second Tuesday", "END:VEVENT",
  "BEGIN:VEVENT", "UID:bday-1", "DTSTART;VALUE=DATE:19900315", "RRULE:FREQ=YEARLY", "SUMMARY:Birthday", "END:VEVENT",
  "BEGIN:VEVENT", "UID:moved-1", "DTSTART:20261201T100000Z", "DTEND:20261201T110000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Workshop", "END:VEVENT",
  "BEGIN:VEVENT", "UID:moved-1", "RECURRENCE-ID:20261202T100000Z", "DTSTART:20261202T150000Z", "DTEND:20261202T160000Z", "SUMMARY:Workshop (moved)", "END:VEVENT",
  "BEGIN:VEVENT", "UID:cancel-1", "DTSTART:20261015T100000Z", "STATUS:CANCELLED", "SUMMARY:Cancelled meeting", "END:VEVENT",
  "END:VCALENDAR", "",
].join("\r\n");

const got = []; // every request the two test sites received
let baseA = "", baseB = "";
const site = (name) => http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const u = new URL(req.url, "http://x"), p = u.pathname; got.push({ site: name, method: req.method, path: p, headers: req.headers, body });
  const j = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (name === "b") return j(200, { site: "b", key: req.headers["x-api-key"] || null });
  if (p.startsWith("/api/webhooks/123/")) { res.writeHead(204); return res.end(); }
  if (p.startsWith("/api/webhooks/999/")) return j(404, { message: "Unknown Webhook", code: 10015 });
  if (p.startsWith("/services/")) { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  if (p === "/cal.ics") { res.writeHead(200, { "content-type": "text/calendar" }); return res.end(ICS); }
  if (p === "/huge.ics") { res.writeHead(200, { "content-type": "text/calendar" }); return res.end("BEGIN:VCALENDAR\r\n" + "X".repeat(11 * 1024 * 1024)); }
  if (p === "/page.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><body>Not a calendar</body></html>"); }
  if (p === "/api/echo") return j(200, { site: "a", key: req.headers["x-api-key"] || null });
  if (p === "/api/out") { res.writeHead(302, { location: baseB + "/echo" }); return res.end(); }
  if (p === "/api/in") { res.writeHead(302, { location: "/api/echo" }); return res.end(); }
  res.writeHead(404); res.end("no such page");
});
const siteA = site("a"), siteB = site("b");
await new Promise((ok) => siteA.listen(0, "127.0.0.1", ok)); await new Promise((ok) => siteB.listen(0, "127.0.0.1", ok));
baseA = `http://127.0.0.1:${siteA.address().port}`; baseB = `http://127.0.0.1:${siteB.address().port}`;
const hook = (id, tok) => `${baseA}/api/webhooks/${id}/${tok}`, calUrl = `${baseA}/cal.ics?key=${S.cal}`;
const CF = path.join(data, "OmniRouteChat", "connections.json");

try {
  fs.mkdirSync(W, { recursive: true });
  // ---- saving, and what the page and the disk see
  const saved = {};
  const add = { discord: { type: "webhook", name: "Team chat", secret: hook(123, S.discord) }, slack: { type: "webhook", name: "Ops Slack", secret: `${baseA}/services/T000/B000/${S.slack}` }, gone: { type: "webhook", name: "Old hook", secret: hook(999, S.gone) },
    cal: { type: "calendar", name: "Work calendar", secret: calUrl }, api: { type: "api", name: "Weather API", base: baseA + "/api/", header: "X-Api-Key", secret: "Bearer " + S.api },
    huge: { type: "calendar", name: "Huge cal", secret: baseA + "/huge.ics" }, page: { type: "calendar", name: "Not a cal", secret: baseA + "/page.html" } };
  for (const [k, v] of Object.entries(add)) saved[k] = await C.saveConnection(v);
  check("accounts are saved with their kind, host and header", saved.discord.kind === "discord" && saved.slack.kind === "slack" && saved.api.header === "X-Api-Key" && saved.api.base === baseA + "/api" && saved.cal.host === new URL(baseA).host, JSON.stringify(saved.api));
  const pubText = JSON.stringify(C.publicList());
  check("the public list has names, types and hosts, never a secret", ["Team chat", "Ops Slack", "Work calendar", "Weather API"].every((n) => pubText.includes(n)) && !leaks(pubText).length && !/"secret"|"plain"/.test(pubText), leaks(pubText).join(", "));
  const raw = fs.readFileSync(CF, "utf8"), J = JSON.parse(raw), decoded = J.connections.map((c) => Buffer.from(c.secret, "base64").toString("latin1")).join("\n");
  if (win) check("connections.json holds no secret in plain text (encrypted with DPAPI for this Windows user)", !leaks(raw).length && !leaks(decoded).length && J.connections.every((c) => !c.plain), leaks(raw + decoded).join(", "));
  else check("connections.json marks the unencrypted test secrets (Windows encrypts them with DPAPI)", J.connections.every((c) => c.plain === true) && !leaks(raw).length);
  C.forgetCache();
  const back = await C.reveal(J.connections.find((c) => c.name === "Weather API")).catch((e) => "ERROR " + e.message);
  check(win ? "a DPAPI-encrypted key is read back for the same Windows user" : "a saved key is read back inside the backend", back === "Bearer " + S.api, win ? "" : "(the DPAPI round trip runs on Windows)");
  const saveErr = (v) => fails(C.saveConnection(v));
  check("only Discord and Slack webhook links are accepted, over https", /not a Discord or Slack/.test(await saveErr({ type: "webhook", name: "x1", secret: "https://example.com/api/webhooks/1/abc" })) && /not a Discord or Slack/.test(await saveErr({ type: "webhook", name: "x2", secret: "https://192.168.1.5/api/webhooks/1/abc" })) && /https/.test(await saveErr({ type: "webhook", name: "x3", secret: "http://discord.com/api/webhooks/1/abc" })));
  check("duplicate names, API keys over plain http and odd header names are refused", /already exists/.test(await saveErr({ type: "webhook", name: "team CHAT", secret: hook(123, "x") })) && /https/.test(await saveErr({ type: "api", name: "x4", base: "http://api.example.com", secret: "k" })) && /header name/.test(await saveErr({ type: "api", name: "x5", base: "https://api.example.com", header: "Bad Header", secret: "k" })) && /web address/.test(await saveErr({ type: "calendar", name: "x6", secret: "my calendar" })));

  // ---- list_connections
  let r = await R("list_connections", {});
  check("list_connections says what each account is for, without secrets", /"Team chat": Discord channel/.test(r) && /"Ops Slack": Slack channel/.test(r) && /"Work calendar": calendar/.test(r) && /"Weather API": API key for http:\/\/127\.0\.0\.1:\d+\/api \(sent as the X-Api-Key header\)/.test(r) && /GitHub: signed in as octo-test/.test(r) && !leaks(r).length, r.split("\n").slice(0, 2).join(" | "));

  // ---- send_message
  const msg = { connection: "Team chat", title: "Status", text: "Build finished @everyone" };
  const pm = await Promise.all(["ask", "auto", "highonly", "bypass"].map((a) => tools.precheck("send_message", msg, { ...cfg, approval: a })));
  check("send_message always asks, in every approval mode (bypass too)", pm.every((p) => p.confirm === true && p.class === "network"));
  check("the approval shows the exact text and the channel, never the link", /^Post to "Team chat" \(Discord\):\nStatus\nBuild finished @everyone$/.test(pm[0].summary) && !leaks(pm[0].summary).length, pm[0].summary.replace(/\n/g, " | "));
  got.length = 0; r = await R("send_message", msg);
  const dj = JSON.parse(got.find((g) => g.path.startsWith("/api/webhooks/123/"))?.body || "{}");
  check("Discord gets {content} with mentions switched off", r === 'Sent to "Team chat" (Discord).' && dj.content === "**Status**\nBuild finished @everyone" && JSON.stringify(dj.allowed_mentions) === '{"parse":[]}' && got[0].headers["content-type"] === "application/json", r + " " + JSON.stringify(dj));
  got.length = 0; r = await R("send_message", { connection: "ops slack", title: "Status", text: "Build finished" });
  const sj = JSON.parse(got.find((g) => g.path.startsWith("/services/"))?.body || "{}");
  check("Slack gets {text}", r === 'Sent to "Ops Slack" (Slack).' && sj.text === "*Status*\nBuild finished" && !("content" in sj), r + " " + JSON.stringify(sj));
  got.length = 0; await R("send_message", { connection: "ops slack", text: "Hi <!channel> and <@U123> & <!here>" });
  check("Slack mentions are sent as plain text, so nobody is pinged", JSON.parse(got.find((g) => g.path.startsWith("/services/"))?.body || "{}").text === "Hi &lt;!channel&gt; and &lt;@U123&gt; &amp; &lt;!here&gt;", got[0]?.body);
  check("message limits: Discord 2000 characters, Slack 40000", /at most 2000/.test(await refused("send_message", { connection: "Team chat", text: "x".repeat(2001) })) && !(await refused("send_message", { connection: "Ops Slack", text: "x".repeat(2001) })) && /at most 40000/.test(await refused("send_message", { connection: "Ops Slack", text: "x".repeat(40001) })) && /text is required/.test(await refused("send_message", { connection: "Team chat", text: " " })));
  const goneErr = await fails(R("send_message", { connection: "Old hook", text: "hi" }));
  check("a deleted webhook is reported plainly, without its link", /HTTP 404/.test(goneErr) && /may have been deleted/.test(goneErr) && !leaks(goneErr).length, goneErr);
  check("send_message only takes a saved Discord or Slack channel", /No account named "Nope"/.test(await refused("send_message", { connection: "Nope", text: "x" })) && /not a Discord or Slack channel/.test(await refused("send_message", { connection: "Work calendar", text: "x" })));
  const cmdBad = ['Copy-Item "$env:LOCALAPPDATA\\OmniRouteChat\\connections.json" copy.json', "type %LOCALAPPDATA%\\OmniRouteChat\\connections.json", "[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')"];
  const cmdRes = await Promise.all(cmdBad.flatMap((c) => ["ask", "bypass"].map((a) => refused("run_command", { command: c }, { ...cfg, approval: a }))));
  check("commands cannot read the saved accounts or decrypt them, even in bypass mode", cmdRes.every((m) => /credential or protected-location/.test(m)), cmdRes.map((m) => m || "(allowed)").join(" | "));
  check("parallel workers cannot send messages or use GitHub", /not available to parallel workers/.test(await fails(tools.precheck("send_message", msg, cfg, { writes: [] }))) && /not available to parallel workers/.test(await fails(tools.precheck("github", { args: ["status"] }, cfg, { writes: [] }))));
  // links that point at private or local addresses (planted in the file by hand) are refused like downloads
  J.connections.push({ id: "cpriv1", type: "webhook", name: "Private hook", kind: "discord", host: "127.0.0.1", hint: "…", created: 1, secret: Buffer.from("http://127.0.0.1/api/webhooks/1/" + S.priv).toString("base64"), plain: true },
    { id: "cpriv2", type: "calendar", name: "Private cal", host: "10.1.2.3", created: 1, secret: Buffer.from("http://10.1.2.3/cal.ics").toString("base64"), plain: true });
  fs.writeFileSync(CF, JSON.stringify(J));
  const privErr = await refused("send_message", { connection: "Private hook", text: "x" });
  check("a webhook on a private or local address is refused", /private\/local address/.test(privErr) && !leaks(privErr).length, privErr);

  // ---- calendar parsing
  const all = C.expandIcs(C.parseIcs(ICS), new Date(2026, 0, 1).getTime(), new Date(2027, 0, 1).getTime()), by = (s) => all.filter((e) => e.summary === s), starts = (s) => JSON.stringify(by(s).map((e) => iso(e.start)));
  const su = by("Team standup")[0] || {};
  check("a timed UTC event", by("Team standup").length === 1 && iso(su.start) === "2026-10-12T09:00" && iso(su.end) === "2026-10-12T09:30");
  check("text is unescaped, folded lines are joined, reminders (VALARM) are ignored", su.location === "Room 4, second floor" && su.description === "Agenda:\nUpdates\nBlockers and a long line that is folded across two lines", JSON.stringify(su.description));
  const hol = by("Company holiday")[0] || {};
  check("an all-day event (VALUE=DATE) covers the whole local day", hol.allDay === true && hol.start === new Date(2026, 9, 13).getTime() && hol.end === new Date(2026, 9, 14).getTime());
  check("a TZID event is converted (09:00 in New York is 13:00 UTC in October)", iso(by("Call with New York")[0]?.start) === "2026-10-14T13:00" && iso(by("Call with New York")[0]?.end) === "2026-10-14T13:30");
  check("weekly with BYDAY and COUNT, an EXDATE removed, the time kept across the DST change", starts("Planning") === '["2026-10-26T14:00","2026-11-02T15:00","2026-11-04T15:00"]' && iso(by("Planning")[1]?.end) === "2026-11-02T16:00", starts("Planning"));
  check("daily with INTERVAL and UNTIL (UNTIL included)", starts("Water the plants") === '["2026-11-01T12:00","2026-11-03T12:00","2026-11-05T12:00","2026-11-07T12:00"]', starts("Water the plants"));
  check("a Windows time zone name uses the calendar's own VTIMEZONE rules", starts("Berlin sync") === '["2026-10-20T13:00","2026-10-27T14:00","2026-11-03T14:00"]', starts("Berlin sync"));
  check("monthly on the 31st skips shorter months", JSON.stringify(by("Month end").map((e) => ld(e.start))) === '["2026-01-31","2026-03-31","2026-05-31","2026-07-31"]', JSON.stringify(by("Month end").map((e) => ld(e.start))));
  check("monthly on the second Tuesday until a date", starts("Second Tuesday") === '["2026-01-13T17:00","2026-02-10T17:00","2026-03-10T17:00","2026-04-14T17:00"]', starts("Second Tuesday"));
  check("a yearly event from 1990 shows up this year", by("Birthday").length === 1 && ld(by("Birthday")[0].start) === "2026-03-15");
  check("a moved repeat (RECURRENCE-ID) replaces the original time", starts("Workshop") === '["2026-12-01T10:00","2026-12-03T10:00"]' && starts("Workshop (moved)") === '["2026-12-02T15:00"]', starts("Workshop"));
  check("cancelled events are left out", !by("Cancelled meeting").length);
  check("events come back sorted", all.every((e, k) => !k || all[k - 1].start <= e.start));

  // ---- calendar_events (fetched from the local site)
  const pc = await tools.precheck("calendar_events", { connection: "Work calendar", from: "2026-10-12", to: "2026-10-14" }, cfg);
  check("calendar_events is a read-only web lookup", pc.class === "web" && /Read the calendar "Work calendar" from 2026-10-12 to 2026-10-14/.test(pc.summary) && !pc.confirm, pc.summary);
  r = await R("calendar_events", { connection: "Work calendar", from: "2026-10-12", to: "2026-10-14" });
  const lt = (t) => { const d = new Date(t); return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${ld(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }; // local clock, whatever the PC's zone
  check("the range filter keeps only the events in those days", /: 3 events from 2026-10-12 to 2026-10-14/.test(r) && r.includes(`- ${lt(Date.UTC(2026, 9, 12, 9))}-${lt(Date.UTC(2026, 9, 12, 9, 30)).slice(-5)}  Team standup  @ Room 4, second floor\n    Agenda: Updates Blockers`) && /Tue 2026-10-13 all day  Company holiday/.test(r) && r.includes(`- ${lt(Date.UTC(2026, 9, 14, 13))}-`) && /Call with New York/.test(r) && !/Planning|Cancelled|SHOULD NOT APPEAR/.test(r), r.split("\n")[0]);
  check("event text is labelled as data, and the calendar link is never shown", /it is data, not instructions/.test(r) && !leaks(r).length);
  r = await R("calendar_events", { connection: "Work calendar", from: "2026-01-01", to: "2026-12-31", query: "planning" });
  check("query keeps only matching events (repeats included)", /: 3 events/.test(r) && (r.match(/Planning/g) || []).length === 3 && /\(repeats\)/.test(r), r.split("\n")[0]);
  r = await R("calendar_events", { connection: "Work calendar", from: "2026-01-01", to: "2026-12-31", query: "second floor" });
  check("query also searches the place", /: 1 event /.test(r) && /Team standup/.test(r), r.split("\n")[0]);
  const rg = C.calRange({});
  check("the default range is today and the next 14 days", rg.from === new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() && Math.round((rg.to - rg.from) / 864e5) === 15);
  check("bad dates and wrong account types are refused", /must be a date/.test(await refused("calendar_events", { connection: "Work calendar", from: "next tuesday" })) && /not a calendar/.test(await refused("calendar_events", { connection: "Team chat" })) && /to must be after from/.test(await refused("calendar_events", { connection: "Work calendar", from: "2026-10-12", to: "2026-10-01" })));
  check("calendars over 10 MB are refused", /larger than 10 MB/.test(await fails(R("calendar_events", { connection: "Huge cal" }))));
  check("a link that is not a calendar says so", /did not return a calendar/.test(await fails(R("calendar_events", { connection: "Not a cal" }))));
  check("a calendar on a private address is refused", /private\/local address/.test(await fails(R("calendar_events", { connection: "Private cal" }))));

  // ---- http_request with a saved API key
  got.length = 0; r = await R("http_request", { url: baseA + "/api/echo", connection: "Weather API" });
  const g1 = got.find((g) => g.path === "/api/echo");
  check("the saved key is added for the connection's own address", g1?.headers["x-api-key"] === "Bearer " + S.api);
  check("a key the API echoes back is hidden from the model", /"key": "\[secret\]"/.test(r) && !leaks(r).length, r.split("\n").slice(-3).join(" "));
  check("the key is never sent to another address", /only sent to http:\/\/127\.0\.0\.1:\d+; this request goes to/.test(await refused("http_request", { url: baseB + "/echo", connection: "Weather API" })));
  got.length = 0; r = await R("http_request", { url: baseA + "/api/out", connection: "Weather API" });
  const gb = got.find((g) => g.site === "b");
  check("a redirect to another host drops the key", gb && !gb.headers["x-api-key"] && /"site": "b"/.test(r) && /"key": null/.test(r), gb ? JSON.stringify(gb.headers["x-api-key"]) : "site b was not reached");
  got.length = 0; r = await R("http_request", { url: baseA + "/api/in", connection: "Weather API" });
  check("a redirect on the same host keeps it", got.length === 2 && got.every((g) => g.headers["x-api-key"] === "Bearer " + S.api) && /\[secret\]/.test(r) && !leaks(r).length);
  const ph = await tools.precheck("http_request", { url: baseA + "/api/echo", connection: "Weather API" }, cfg);
  check("the approval names the saved key, never its value", /Uses the saved key "Weather API" \(X-Api-Key header\)/.test(ph.summary) && !leaks(ph.summary).length && ph.class === "web");
  check("keys typed into headers are still refused, with or without a connection", /Settings > Accounts/.test(await refused("http_request", { url: baseA + "/api/echo", connection: "Weather API", headers: { Authorization: "Bearer x" } })) && /Settings > Accounts/.test(await refused("http_request", { url: baseA + "/api/echo", headers: { "X-API-Key": "x" } })));
  check("connection must name an API key", /not an API key/.test(await refused("http_request", { url: baseA + "/api/echo", connection: "Team chat" })) && /No account named/.test(await refused("http_request", { url: baseA + "/api/echo", connection: "Nope" })));

  // ---- github (fake gh)
  const secretFile = path.join(os.homedir(), ".ssh", "id_rsa");
  fs.writeFileSync(path.join(W, "body.md"), "Issue text");
  const ghBad = [
    [["auth", "token"], /never run/], [["auth", "status"], /never run/], [["secret", "list"], /never run/], [["ssh-key", "add", "k.pub"], /never run/], [["gist", "list"], /never run/], [["extension", "install", "x/y"], /never run/], [["config", "get", "editor"], /never run/], [["codespace", "list"], /never run/], [["alias", "set", "x", "y"], /never run/],
    [["api", "-X", "POST", "repos/o/r/issues"], /must be GET/], [["api", "--method=DELETE", "repos/o/r"], /must be GET/], [["api", "-f", "x=y", "repos/o/r"], /only reads/], [["api", "repos/o/r/issues", "-F", "title=x"], /only reads/], [["api", "repos/o/r", "--input", "body.json"], /only reads/], [["api", "graphql"], /no GraphQL/], [["api", "https://evil.example.com/x"], /no full web/], [["api", "-XPOST", "repos/o/r"], /short option/],
    [["pr", "checkout", "1"], /not allowed/], [["browse"], /not allowed/], [["workflow", "run", "x"], /not allowed/], [["issue", "-R", "o/r", "create"], /subcommand right after/], [["issue", "create", "-bx"], /short option/], [["issue", "create", "--title", "t", "-F", secretFile], /outside the allowed|Protected/], [["issue", "comment", "1", "-e"], /editor/],
    [["repo", "clone", "o/r", "--", "--config", "core.x=y"], /"--" is not allowed/], [["repo", "clone", "https://evil.example.com/x.git"], /only takes GitHub/], [["release", "download", "v1", "--clobber"], /clobber/], [[], /args is required/], ["issue list", /args is required/],
  ];
  const ghRes = await Promise.all(ghBad.map(([a]) => refused("github", { args: a })));
  check(`gh commands outside the allowlist are refused (${ghBad.length} cases)`, ghRes.every((m, k) => ghBad[k][1].test(m)), ghRes.map((m, k) => (ghBad[k][1].test(m) ? "" : JSON.stringify(ghBad[k][0]) + " -> " + (m || "(accepted)"))).filter(Boolean).join(" | "));
  const cls = async (a) => { const p = await tools.precheck("github", { args: a }, cfg).catch((e) => ({ class: "ERR " + e.message })); return p.class + (p.confirm ? "+ask" : ""); };
  const want = [[["issue", "list", "-R", "o/r"], "read"], [["api", "repos/o/r/pulls?state=open", "--jq", ".[].title"], "read"], [["api", "-X", "GET", "repos/o/r"], "read"], [["status"], "read"], [["search", "issues", "label:bug", "--limit", "5"], "read"], [["pr", "diff", "5", "-R", "o/r"], "read"], [["run", "view", "77", "--log-failed"], "read"],
    [["issue", "create", "-R", "o/r", "--title", "t", "--body", "b"], "write+ask"], [["issue", "create", "--title", "t", "-F", "body.md"], "write+ask"], [["issue", "comment", "3", "--body", "ok"], "write+ask"], [["pr", "merge", "5", "-R", "o/r", "--squash"], "write+ask"], [["pr", "review", "5", "--approve"], "write+ask"], [["issue", "close", "3"], "write+ask"], [["issue", "reopen", "3"], "write+ask"],
    [["repo", "clone", "o/r"], "write"], [["release", "download", "v1", "-R", "o/r"], "write"]];
  const clsRes = await Promise.all(want.map(([a]) => cls(a)));
  check("reads are reads; creating, commenting, closing, merging and reviewing always ask; clone and downloads are file changes", clsRes.every((c, k) => c === want[k][1]), clsRes.map((c, k) => (c === want[k][1] ? "" : JSON.stringify(want[k][0]) + " -> " + c)).filter(Boolean).join(" | "));
  r = await R("github", { args: ["issue", "list", "-R", "o/r"] });
  let out = {}; try { out = JSON.parse(r.split("\n")[0]); } catch {}
  const same = (a, b) => { try { return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase(); } catch { return false; } };
  check("gh gets exactly the arguments, runs in the working folder, with prompts, colour and update checks off", JSON.stringify(out.args) === '["issue","list","-R","o/r"]' && same(out.cwd, W) && out.prompt === "1" && out.color === "1" && out.notifier === "1", r.split("\n")[0].slice(0, 200));
  check("secret environment variables never reach gh, and tokens in its output are hidden", out.leaked === null && !/gho_A{20}/.test(r) && !/github_pat_11/.test(r) && (r.match(/\[token hidden\]/g) || []).length === 2 && /\[exit code 0\]$/.test(r));
  const meta = { turn: "t-conn-" + process.pid };
  r = await R("github", { args: ["repo", "clone", "octo/hello"] }, meta);
  check("repo clone goes into the working folder and can be undone", fs.existsSync(path.join(W, "hello", "README.md")) && tools.undoInfo(meta.turn).changes === 1, r.split("\n")[0].slice(0, 160));
  check("clone never replaces an existing folder", /already exists/.test(await refused("github", { args: ["repo", "clone", "octo/hello"] })));
  process.env.OMNIGPT_GH = path.join(tmp, "missing-gh.exe");
  const miss = await fails(R("github", { args: ["status"] }));
  check("without gh the agent is told to install it (install_tool winget GitHub.cli)", /install_tool/.test(miss) && /GitHub\.cli/.test(miss), miss);
  check("Settings shows gh as not installed", (await C.ghStatus()).installed === false);
  process.env.OMNIGPT_GH = JSON.stringify([process.execPath, fakeGh]); // the other form of the test hook: a program plus its first arguments
  const st = await C.ghStatus();
  check("gh auth status gives the account name only (never a token)", st.installed && st.loggedIn && st.account === "octo-test" && !/gho_|Token/.test(JSON.stringify(st)), JSON.stringify(st));
  process.env.OMNIGPT_GH = fakeGh;
  if (!win) check("Connect explains that signing in opens a window on Windows", /Windows/.test(await fails(C.ghLogin())));

  // ---- the page's own code: tool list, exclusions, system prompt, Settings pane
  const appjs = fs.readFileSync(path.join(src, "app.js"), "utf8"), html = fs.readFileSync(path.join(src, "index.html"), "utf8");
  const names = [...appjs.slice(appjs.indexOf("const TOOLS=["), appjs.indexOf("const WEB_TOOLS=")).matchAll(/^ \{name:"([a-z_]+)"/gm)].map((m) => m[1]), at = names.indexOf("make_chart");
  check("the four account tools follow make_chart in the tool list", names.slice(at + 1, at + 5).join() === "list_connections,send_message,calendar_events,github", names.slice(at, at + 6).join());
  const wl = appjs.split("\n").find((l) => l.includes("const wtools=")) || "", dl = appjs.split("\n").find((l) => l.includes('mode==="read"?TOOLS.filter')) || "";
  check("parallel workers and helpers never get send_message or github", /\|send_message\|github\)\$/.test(wl) && /\|send_message\|github\)\$/.test(dl.slice(dl.lastIndexOf("TOOLS.filter"))));
  check("the agent is told to use list_connections and to point to Settings > Accounts", /Accounts: use list_connections[^\n]*send_message always asks[^\n]*never ask the user to paste a token[^\n]*Settings > Accounts/.test(appjs));
  check("Settings has an Accounts pane next to Connection", /data-p="connection">Connection<\/button><button data-p="accounts">Accounts<\/button>/.test(html) && /accounts:\(\)=>/.test(appjs));
} catch (e) { check("connections test", false, String(e.stack || e)); }

// ---- the backend's endpoints, in a throwaway backend
const port = process.env.OMNIGPT_TEST_PORT ? String(Number(process.env.OMNIGPT_TEST_PORT) + 5) : "20175", sbase = `http://127.0.0.1:${port}`, sdata = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-conntest-srv-"));
const env = { ...process.env, OMNIGPT_PORT: port, LOCALAPPDATA: sdata, OMNIROUTE_URL: "http://127.0.0.1:9", OMNIROUTE_SCRIPT: path.join(sdata, "no-omniroute.mjs"), OMNIGPT_GH: fakeGh, OMNIGPT_TEST_ALLOW_LOCAL: "1" };
delete env.OMNIGPT_PARENT_PID; delete env.OMNIROUTE_API_KEY; delete env.TZ;
const srv = spawn(process.execPath, [path.join(src, "server.mjs")], { env, stdio: "ignore", windowsHide: true });
try {
  let token = "";
  for (let k = 0; k < 60 && !token; k++) { try { token = /TOKEN0="([0-9a-f]{16,})"/.exec(await (await fetch(sbase + "/")).text())?.[1] || ""; } catch { await sleep(250); } }
  if (!token) throw new Error("the backend did not start");
  const call = async (u, body) => { const res = await fetch(sbase + u, { method: body ? "POST" : "GET", headers: { "x-app-token": token, "content-type": "application/json" }, body: body && JSON.stringify(body) }); return { status: res.status, text: await res.text() }; };
  check("the accounts endpoints need the page's token", (await fetch(sbase + "/api/connections")).status === 403 && (await fetch(sbase + "/api/connections/save", { method: "POST", body: "{}" })).status === 403);
  const s1 = await call("/api/connections/save", { type: "webhook", name: "Srv hook", secret: hook(123, S.srv) });
  const s2 = await call("/api/connections/save", { type: "api", name: "Srv api", base: "https://api.example.com/v1", header: "X-Api-Key", secret: S.srvApi });
  const s3 = await call("/api/connections/save", { type: "calendar", name: "Srv cal", secret: calUrl });
  check("saving from Settings returns only public details", [s1, s2, s3].every((x) => JSON.parse(x.text).ok) && !leaks(s1.text + s2.text + s3.text).length, [s1, s2, s3].map((x) => x.text.slice(0, 80)).join(" | "));
  const lst = await call("/api/connections");
  check("/api/connections lists names, hosts and the GitHub sign-in, never a secret", /"Srv hook"/.test(lst.text) && /"Srv api"/.test(lst.text) && /api\.example\.com/.test(lst.text) && /"account":"octo-test"/.test(lst.text) && !leaks(lst.text).length && !/"secret"/.test(lst.text), leaks(lst.text).join(", "));
  const id = (x) => JSON.parse(x.text).connection.id;
  const t3 = JSON.parse((await call("/api/connections/test", { id: id(s3) })).text);
  check("Test reads a calendar and counts its events", t3.ok && /Read the calendar: \d+ entries/.test(t3.message), JSON.stringify(t3));
  got.length = 0; const t1 = await call("/api/connections/test", { id: id(s1) });
  check("Test on a webhook sends no message and shows no link", JSON.parse(t1.text).ok && !got.length && !leaks(t1.text).length, t1.text);
  const pre = JSON.parse((await call("/api/precheck", { name: "send_message", input: { connection: "Srv hook", text: "hello" } })).text);
  check("the backend's check for send_message always asks and shows no link", pre.ok && pre.confirm === true && !leaks(JSON.stringify(pre)).length, JSON.stringify(pre).slice(0, 160));
  const run = await call("/api/run", { name: "list_connections", input: {} });
  check("list_connections from the backend shows no secret", /Srv hook/.test(run.text) && !leaks(run.text).length);
  const sraw = fs.readFileSync(path.join(sdata, "OmniRouteChat", "connections.json"), "utf8");
  check(win ? "the backend stores the secrets encrypted (DPAPI)" : "the backend marks unencrypted test secrets", !leaks(sraw).length && (win ? !/"plain"/.test(sraw) : /"plain": true/.test(sraw)));
  const del = JSON.parse((await call("/api/connections/delete", { id: id(s1) })).text), after = await call("/api/connections");
  check("Remove deletes the account", del.ok && !/Srv hook/.test(after.text) && /Srv api/.test(after.text));
  if (!win) check("Connect (GitHub) answers with a plain message off Windows", /Windows/.test(JSON.parse((await call("/api/connections/github-login", {})).text).error || ""));
} catch (e) { check("backend endpoints", false, String(e.message || e)); }
srv.kill(); for (let k = 0; k < 40 && srv.exitCode === null && srv.signalCode === null; k++) await sleep(100);

// ---- Settings > Accounts in the real page (headless Edge or Chromium)
const { openApp, findBrowser } = await import("./pagekit.mjs");
if (!findBrowser()) console.log("SKIP  Settings > Accounts page check (no Edge or Chromium found)");
else {
  let app;
  try {
    app = await openApp({ port, env: { OMNIGPT_GH: fakeGh, OMNIGPT_TEST_ALLOW_LOCAL: "1" } });
    const E = (js) => app.evaluate(js), until = async (js, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await E(js)) return true; await sleep(200); } return false; };
    await E(`showPane("accounts"); $("#dlg").showModal(); true`);
    check("the Accounts pane shows the GitHub sign-in", await until(`/Signed in as octo-test/.test($("#acclist").textContent)`), await E(`$("#acclist").textContent.slice(0,120)`));
    await E(`$("#acc-name").value="Page hook"; $("#acc-secret").value=${JSON.stringify(hook(123, S.page))}; $("#acc-save").click(); true`);
    check("adding a webhook lists it with its host and a masked hint", await until(`/Page hook/.test($("#acclist").textContent)&&/Discord channel/.test($("#acclist").textContent)`) && await E(`$("#acc-secret").value===""&&$("#acc-name").value===""`));
    check("the page never holds the saved link", !leaks(await E(`document.documentElement.outerHTML+JSON.stringify(localStorage)`)).length);
    await E(`const s=$("#acc-type"); s.value="api"; s.dispatchEvent(new Event("change",{bubbles:true})); true`);
    check("choosing Web API key shows the address, header and key fields", await E(`!!$("#acc-base")&&$("#acc-header").value==="Authorization"&&$("#acc-secret").type==="password"`));
    await E(`$("#acc-name").value="Bad api"; $("#acc-base").value="http://api.example.com"; $("#acc-secret").value="k"; $("#acc-save").click(); true`);
    check("a refused save shows the reason", await until(`$("#acc-res").classList.contains("bad")&&/https/.test($("#acc-res").textContent)`), await E(`$("#acc-res").textContent`));
    await E(`[...document.querySelectorAll("[data-ctest]")].find(b=>b.dataset.ctest!=="github").click(); true`);
    check("Test reports on the webhook without sending anything", await until(`[...document.querySelectorAll(".acc-res[data-res]")].some(e=>/webhook address/.test(e.textContent))`));
    await E(`document.querySelector("[data-cdel]").click(); true`);
    await until(`$("#adlg").open`, 5000); await E(`$("#a-ok").click(); true`);
    check("Remove asks first, then deletes the account", await until(`!/Page hook/.test($("#acclist").textContent)&&/No other accounts/.test($("#acclist").textContent)`));
    check("no page errors", !app.logs.length, app.logs.join("; "));
  } catch (e) { check("Settings > Accounts page", false, String(e.message || e)); }
  if (app) await app.close();
}

siteA.close(); siteB.close();
for (const d of [W, data, tmp, sdata]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(failed ? `${failed} check(s) failed.` : "All account connection checks passed.");
process.exit(failed ? 1 : 0);
