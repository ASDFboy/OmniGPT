// Built with Claude (Anthropic) - see CREDITS.md
// Everyday-task benchmark: about 30 tasks run through the real OmniGPT page against the OmniRoute you are running.
// Each task gets its own throwaway folder (a hidden folder in OmniRoute Workspace, deleted afterwards) with prepared files.
// Agents may only use that folder, approval is "bypass" in a temporary config, learning is off so every task starts the
// same, and nobody answers questions (the benchmark tells the agent to decide itself). Outcomes are checked by looking at
// the files and the answer. Prints a table per task and writes bench-report.json next to this file.
// Run in PowerShell from the repository folder:
//   node omnigpt\windows\tests\bench.mjs                      every task (can take an hour on free models)
//   node omnigpt\windows\tests\bench.mjs --only=csv-average,docx-heading
//   node omnigpt\windows\tests\bench.mjs --list               the task names
//   options: --timeout=300 (seconds per task)  --keep (keep the task folders)  --fake (scripted stand-in OmniRoute, tests the harness)
// Needs OMNIROUTE_API_KEY, or the key OmniGPT saved (%LOCALAPPDATA%\OmniRouteChat\omniroute-key.txt). OMNIROUTE_URL default http://127.0.0.1:20128.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openApp, findBrowser, src } from "./pagekit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { zipRead, zipBuild } = await import(pathToFileURL(path.join(src, "zip.mjs")).href);
const { toDocx, parseMarkdown } = await import(pathToFileURL(path.join(src, "docs.mjs")).href);
const { inspect } = await import(pathToFileURL(path.join(src, "files.mjs")).href);
const args = process.argv.slice(2), flag = (f) => args.includes(f), opt = (k) => (args.find((a) => a.startsWith("--" + k + "=")) || "").split("=").slice(1).join("=");
const FAKE = flag("--fake"), QUICK = flag("--quick"), TIMEOUT = Number(opt("timeout")) || (FAKE ? 60 : 300), WIN = process.platform === "win32";
const J = JSON.stringify;

// ---------- fixtures and checks
const put = (d, f, data) => { const p = path.join(d, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const rd = (d, f) => { try { return fs.readFileSync(path.join(d, f), "utf8"); } catch { return null; } };
const ex = (d, f) => fs.existsSync(path.join(d, f));
const ls = (d, sub = "") => { try { return fs.readdirSync(path.join(d, sub)); } catch { return []; } };
const walk = (d, sub = "") => ls(d, sub).flatMap((n) => { const r = path.join(sub, n); return fs.statSync(path.join(d, r)).isDirectory() ? walk(d, r) : [r.replace(/\\/g, "/")]; });
const all = (...v) => v.find((x) => x !== true) ?? true; // true, or the first reason something is wrong
const say = (a, re, what) => re.test(a) || "the answer does not mention " + what;
const file = (d, f) => ex(d, f) || f + " was not created";
// every number in a text; "3,116.72", "3.116,72" and a decimal comma ("78,40") are understood
const nums = (a) => (String(a).replace(/(\d)\.(?=\d{3},\d)/g, "$1").replace(/(\d)[,'](?=\d{3}(?!\d))/g, "$1").replace(/(\d),(\d)/g, "$1.$2").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
const near = (a, n, tol) => nums(a.replace(/\[Actions this turn:[^\]]*\]/, "")).some((x) => Math.abs(x - n) <= tol) || "the answer does not contain " + n;
const usedWeb = (a, ctx) => ctx.fake || (ctx.tools || []).some((x) => /^(web_search|web_open|browser|http_request)$/.test(x)) || "no web lookup was made";
const png = (d, f) => { try { const b = fs.readFileSync(path.join(d, f)); return (b.length > 1500 && b.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) || f + " is not a PNG picture"; } catch { return f + " was not created"; } };
const docxParas = (p) => { const z = zipRead(fs.readFileSync(p)), e = z.entries.find((x) => x.name === "word/document.xml"); const x = e ? z.read(e).toString() : "";
  return [...x.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => ({ style: (m[0].match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || "", text: [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join("") })); };
const csvRows = (t) => String(t || "").trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, "")));
const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 255));
function pdf(lines) { // a one-page PDF with real text, written by hand
  const content = Buffer.from("BT /F1 14 Tf 72 720 Td " + lines.map((l, i) => (i ? "0 -22 Td " : "") + "(" + l.replace(/[()\\]/g, "\\$&") + ") Tj").join(" ") + " ET");
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const parts = [Buffer.from("%PDF-1.4\n")], offs = [], size = () => parts.reduce((s, b) => s + b.length, 0);
  objs.forEach((o, i) => { offs.push(size()); parts.push(o ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`) : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream\nendobj\n")])); });
  const xref = size(); parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}
const SCORES = [["Mia", 72], ["Noah", 88], ["Ava", 95], ["Leo", 61], ["Zoe", 79], ["Eli", 84], ["Ivy", 90], ["Max", 67], ["Uma", 73], ["Sam", 75]];
const TEMPS = [["2026-07-01", 27.1], ["2026-07-02", 29.4], ["2026-07-03", 31.0], ["2026-07-04", 30.2], ["2026-07-05", 33.8], ["2026-07-06", 34.5], ["2026-07-07", 32.9], ["2026-07-08", 28.6], ["2026-07-09", 26.3], ["2026-07-10", 29.9]];
const ORDERS = [[1, "Ana", "45.50"], [2, "Ben", "120.00"], [3, "Cleo", "99.99"], [4, "Dev", "250.10"], [5, "Eli", "100.00"], [6, "Fay", "310.75"]];
const PEOPLE = [{ name: "Ada", age: 36, city: "London" }, { name: "Linus", age: 28, city: "Helsinki" }, { name: "Grace", age: 45, city: "New York" }, { name: "Alan", age: 41, city: "Wilmslow" }];
const MONTHS = [["Jan", 120], ["Feb", 150], ["Mar", 90], ["Apr", 200]], SALES = [["North", 1250], ["South", 980], ["East", 1430], ["West", 760]];
const ARTICLE = "Honeybees live in colonies of up to sixty thousand workers led by a single queen. Worker bees collect nectar and pollen from flowers within a few kilometres of the hive, and they tell each other where the best flowers are with a waggle dance. While they forage they pollinate crops such as apples, almonds and blueberries, so farmers rely on them. In recent years colonies have been weakened by mites, viruses, pesticides and a lack of wild flowers. Beekeepers fight back by treating hives against mites, and towns help by planting flowers and cutting grass less often. Scientists say that protecting bees protects a large part of our food supply.";
const LETTER = "Dear Mr Smith,\n\nI am writting to let you know that I did not recieve the package. It was suposed to arrive on Monday.\n\nKind regards,\nAlex\n";
const t = (s) => ({ text: s }), use = (...tools) => ({ text: "Working on it.", tools: tools.map(([name, input]) => ({ name, input })) });

// kind: files, docs, data, text, calc, web, code. fake: the steps a correct agent takes (only for --fake). quick: in the fast self-check.
const TASKS = [
  { id: "rename-ext", kind: "files", quick: true, prompt: "Rename every .txt file in my working folder so it ends in .md instead. Keep the rest of each name.",
    setup: (d) => [1, 2, 3].forEach((n) => put(d, `notes${n}.txt`, "note " + n)),
    check: (d) => all(...[1, 2, 3].map((n) => ex(d, `notes${n}.md`) || `notes${n}.md is missing`), !ls(d).some((f) => f.endsWith(".txt")) || "a .txt file is left"),
    fake: () => [use(["move_files", { moves: [1, 2, 3].map((n) => ({ source: `notes${n}.txt`, destination: `notes${n}.md` })) }]), t("Renamed 3 files.")] },
  { id: "sort-by-type", kind: "files", prompt: "Sort the files in my working folder into two subfolders: Images for the pictures, and Documents for the PDF and text files.",
    setup: (d) => { put(d, "beach.jpg", bytes(900, 1)); put(d, "logo.png", bytes(700, 2)); put(d, "invoice.pdf", pdf(["Invoice"])); put(d, "notes.txt", "notes"); },
    check: (d) => { const dir = (n) => ls(d).find((f) => f.toLowerCase() === n.toLowerCase()) || n; return all(...["beach.jpg", "logo.png"].map((f) => ex(d, path.join(dir("Images"), f)) || f + " is not in Images"), ...["invoice.pdf", "notes.txt"].map((f) => ex(d, path.join(dir("Documents"), f)) || f + " is not in Documents"), !ls(d).some((f) => /\.\w+$/.test(f)) || "files are left at the top"); },
    fake: () => [use(["move_files", { moves: [["beach.jpg", "Images"], ["logo.png", "Images"], ["invoice.pdf", "Documents"], ["notes.txt", "Documents"]].map(([f, k]) => ({ source: f, destination: k + "/" + f })) }]), t("Sorted 4 files.")] },
  { id: "date-prefix", kind: "files", prompt: 'Put each photo\'s last-modified date at the start of its file name, like "2024-03-15 photo1.jpg". The photos are the .jpg files in my working folder.',
    setup: (d) => { put(d, "photo1.jpg", bytes(500, 3)); put(d, "photo2.jpg", bytes(500, 4)); fs.utimesSync(path.join(d, "photo1.jpg"), new Date("2024-03-15T12:00:00Z"), new Date("2024-03-15T12:00:00Z")); fs.utimesSync(path.join(d, "photo2.jpg"), new Date("2023-11-02T12:00:00Z"), new Date("2023-11-02T12:00:00Z")); },
    check: (d) => all(ls(d).some((f) => /^2024-03-15[ _-]+photo1\.jpg$/.test(f)) || "photo1.jpg was not renamed to 2024-03-15 photo1.jpg", ls(d).some((f) => /^2023-11-02[ _-]+photo2\.jpg$/.test(f)) || "photo2.jpg was not renamed to 2023-11-02 photo2.jpg"),
    fake: () => [use(["list_dir", { path: "." }]), use(["move_files", { moves: [{ source: "photo1.jpg", destination: "2024-03-15 photo1.jpg" }, { source: "photo2.jpg", destination: "2023-11-02 photo2.jpg" }] }]), t("Renamed 2 photos.")] },
  { id: "lowercase-names", kind: "files", prompt: "Make every file name in my working folder all lowercase, including the extension.",
    setup: (d) => { put(d, "Report FINAL.TXT", "r"); put(d, "Budget.CSV", "a,b"); put(d, "Photo.JPG", bytes(300, 5)); },
    check: (d) => J(ls(d).sort()) === J(["budget.csv", "photo.jpg", "report final.txt"]) || "names are now: " + ls(d).join(", "),
    fake: () => [use(["move_files", { moves: [["Report FINAL.TXT", "report final.txt"], ["Budget.CSV", "budget.csv"], ["Photo.JPG", "photo.jpg"]].map(([a], k) => ({ source: a, destination: "tmp-rename-" + k })) }]),
      use(["move_files", { moves: ["report final.txt", "budget.csv", "photo.jpg"].map((b, k) => ({ source: "tmp-rename-" + k, destination: b })) }]), t("Renamed 3 files to lowercase.")] },
  { id: "find-duplicates", kind: "files", prompt: "Which files in my working folder and its subfolders have exactly the same content? Only tell me, do not change anything.",
    setup: (d) => { put(d, "a.txt", "Quarterly numbers v1"); put(d, "copy.txt", "Quarterly numbers v1"); put(d, "b.txt", "Something else"); put(d, "sub/a-again.txt", "Quarterly numbers v1"); },
    check: (d, a) => all(say(a, /\ba\.txt/, "a.txt"), say(a, /copy\.txt/, "copy.txt"), say(a, /a-again\.txt/, "a-again.txt"), rd(d, "copy.txt") === "Quarterly numbers v1" && ex(d, "sub/a-again.txt") && ex(d, "a.txt") || "files were changed"),
    fake: () => [use(["find_duplicates", { path: "." }]), t("a.txt, copy.txt and sub/a-again.txt have the same content.")] },
  { id: "delete-duplicates", kind: "files", win: true, prompt: "Delete the duplicate copies in my working folder so only one of each picture is left.",
    setup: (d) => { for (const f of ["x.jpg", "x (1).jpg", "x - Copy.jpg"]) put(d, f, bytes(800, 6)); put(d, "y.jpg", bytes(800, 7)); },
    check: (d) => all(ex(d, "y.jpg") || "y.jpg (not a duplicate) was deleted", ["x.jpg", "x (1).jpg", "x - Copy.jpg"].filter((f) => ex(d, f)).length === 1 || "not exactly one copy of x.jpg is left"),
    fake: () => [use(["find_duplicates", { path: "." }]), use(["delete_files", { paths: ["x (1).jpg", "x - Copy.jpg"] }]), t("Deleted 2 duplicates.")] },
  { id: "find-large", kind: "files", prompt: "Which file in my working folder is the largest, and how big is it?",
    setup: (d) => { put(d, "big.bin", Buffer.alloc(2000000, 1)); put(d, "medium.dat", Buffer.alloc(300000, 2)); put(d, "small1.txt", "tiny"); put(d, "small2.txt", "tiny too"); },
    check: (d, a) => say(a, /big\.bin/, "big.bin"),
    fake: () => [use(["find_files", { pattern: "*", path: ".", sort: "size" }]), t("big.bin is the largest at 1.9 MB.")] },
  { id: "count-files", kind: "files", prompt: "How many .jpg files are there in my working folder, including all subfolders?",
    setup: (d) => { for (const f of ["a.jpg", "b.jpg", "sub/c.jpg", "sub/deeper/d.jpg"]) put(d, f, bytes(200, 8)); put(d, "e.png", bytes(200, 9)); put(d, "sub/f.txt", "f"); },
    check: (d, a) => near(a, 4, 0),
    fake: () => [use(["find_files", { pattern: "**/*.jpg", path: "." }]), t("There are 4 .jpg files.")] },
  { id: "zip-folder", kind: "files", prompt: "Zip the photos folder in my working folder into photos.zip, next to the folder.",
    setup: (d) => [1, 2, 3].forEach((n) => put(d, `photos/p${n}.jpg`, bytes(400, n))),
    check: (d) => { if (!ex(d, "photos.zip")) return "photos.zip was not created"; const names = zipRead(fs.readFileSync(path.join(d, "photos.zip"))).entries.map((e) => e.name); return [1, 2, 3].every((n) => names.some((x) => x.endsWith(`p${n}.jpg`))) || "the zip holds: " + names.join(", "); },
    fake: () => [use(["archive", { action: "zip", source: "photos", destination: "photos.zip" }]), t("Created photos.zip.")] },
  { id: "unzip", kind: "files", prompt: "Extract bundle.zip in my working folder into a folder named bundle.",
    setup: (d) => put(d, "bundle.zip", zipBuild([{ name: "readme.txt", data: Buffer.from("hello from the bundle") }, { name: "data/values.csv", data: Buffer.from("a,b\n1,2\n") }])),
    check: (d) => { const f = walk(d, "bundle").find((x) => x.endsWith("readme.txt")); return (!!f && /hello from the bundle/.test(rd(d, f) || "")) || "bundle/readme.txt was not extracted"; },
    fake: () => [use(["archive", { action: "unzip", source: "bundle.zip", destination: "bundle" }]), t("Extracted 2 files into bundle.")] },
  { id: "docx-heading", kind: "docs", quick: true, prompt: "Create a Word document called meeting.docx in my working folder with the heading \"Team Meeting\" and three bullet points: budget, hiring, launch date.",
    check: (d) => { if (!ex(d, "meeting.docx")) return "meeting.docx was not created"; const P = docxParas(path.join(d, "meeting.docx")), body = P.map((p) => p.text).join(" ");
      return all(P.some((p) => /^(Heading\d|Title)$/i.test(p.style) && /team meeting/i.test(p.text)) || "no heading \"Team Meeting\"", ...["budget", "hiring", "launch"].map((w) => new RegExp(w, "i").test(body) || "the document does not mention " + w)); },
    fake: () => [use(["make_document", { path: "meeting.docx", content: "# Team Meeting\n\n- Budget\n- Hiring\n- Launch date" }]), t("Created meeting.docx.")] },
  { id: "xlsx-from-csv", kind: "docs", prompt: "Turn sales.csv in my working folder into an Excel file sales.xlsx with the same data.",
    setup: (d) => put(d, "sales.csv", "region,amount\n" + SALES.map((r) => r.join(",")).join("\n") + "\n"),
    check: (d) => { if (!ex(d, "sales.xlsx")) return "sales.xlsx was not created"; const x = inspect(path.join(d, "sales.xlsx")); return SALES.every(([r, n]) => x.includes(r) && x.includes(String(n))) || "sales.xlsx does not hold every row"; },
    fake: () => [use(["read_file", { path: "sales.csv" }]), use(["make_document", { path: "sales.xlsx", sheets: [{ name: "Sales", rows: [["region", "amount"], ...SALES] }] }]), t("Created sales.xlsx.")] },
  { id: "html-page", kind: "docs", prompt: "Create a simple web page index.html in my working folder with the title \"My Recipes\" and a list of three recipes.",
    check: (d) => { const h = rd(d, "index.html"); if (h === null) return "index.html was not created"; return all(/<title>\s*My Recipes\s*<\/title>/i.test(h) || "the page title is not My Recipes", (h.match(/<li[\s>]/gi) || []).length >= 3 || "fewer than three list items"); },
    fake: () => [use(["write_file", { path: "index.html", content: "<!doctype html><html><head><title>My Recipes</title></head><body><h1>My Recipes</h1><ul><li>Pancakes</li><li>Tomato soup</li><li>Lemon cake</li></ul></body></html>" }]), t("Created index.html.")] },
  { id: "markdown-table", kind: "docs", prompt: "Make a Markdown file prices.md in my working folder with a table of these fruits and prices: apple 1.20, banana 0.50, cherry 4.00.",
    check: (d) => { const m = rd(d, "prices.md"); if (m === null) return "prices.md was not created"; const rows = m.split("\n").filter((l) => l.includes("|")); return [["apple", /1[.,]20?\b/], ["banana", /0?[.,]50?\b/], ["cherry", /4([.,]00?)?\b/]].every(([f, p]) => rows.some((l) => new RegExp(f, "i").test(l) && p.test(l))) || "the table does not have every fruit with its price"; },
    fake: () => [use(["write_file", { path: "prices.md", content: "| Fruit | Price |\n|---|---|\n| Apple | 1.20 |\n| Banana | 0.50 |\n| Cherry | 4.00 |\n" }]), t("Created prices.md.")] },
  { id: "pdf-answer", kind: "docs", quick: true, prompt: "What is the total due on invoice.pdf in my working folder?",
    setup: (d) => put(d, "invoice.pdf", pdf(["Invoice number: INV-2041", "Customer: Harbor Cafe", "Total due: 482.75 EUR", "Due date: 2026-11-15"])),
    check: (d, a) => near(a, 482.75, 0.001),
    fake: () => [use(["inspect_file", { path: "invoice.pdf" }]), t("The total due is 482.75 EUR.")] },
  { id: "docx-answer", kind: "docs", prompt: "How long is the notice period in contract.docx in my working folder?",
    setup: (d) => put(d, "contract.docx", toDocx(parseMarkdown("# Rental contract\n\nThe rent is due on the first day of each month.\n\n## Ending the contract\n\nThe notice period is 45 days, given in writing."), "Rental contract")),
    check: (d, a) => say(a, /\b45\s*days\b|forty-five days/i, "45 days"),
    fake: () => [use(["inspect_file", { path: "contract.docx" }]), t("The notice period is 45 days, given in writing.")] },
  { id: "csv-average", kind: "data", quick: true, prompt: "What is the average score in scores.csv in my working folder? Round it to 2 decimals.",
    setup: (d) => put(d, "scores.csv", "name,score\n" + SCORES.map((r) => r.join(",")).join("\n") + "\n"),
    check: (d, a) => near(a, 78.4, 0.005),
    fake: () => [use(["read_file", { path: "scores.csv" }]), t("The average score is 78.40.")] },
  { id: "csv-max", kind: "data", prompt: "On which date was the highest temperature in temps.csv in my working folder, and what was it?",
    setup: (d) => put(d, "temps.csv", "date,temp_c\n" + TEMPS.map((r) => r.join(",")).join("\n") + "\n"),
    check: (d, a) => all(say(a, /2026-07-06|July 6|6 July|0?7\/0?6/i, "2026-07-06"), near(a, 34.5, 0.01)),
    fake: () => [use(["read_file", { path: "temps.csv" }]), t("The highest temperature was 34.5 °C on 2026-07-06.")] },
  { id: "csv-filter", kind: "data", prompt: "Make a new file big-orders.csv in my working folder with only the orders from orders.csv whose total is over 100. Keep the same columns.",
    setup: (d) => put(d, "orders.csv", "id,customer,total\n" + ORDERS.map((r) => r.join(",")).join("\n") + "\n"),
    check: (d) => { const r = csvRows(rd(d, "big-orders.csv")); if (!r.length) return "big-orders.csv was not created"; const ids = r.filter((x) => /^\d+$/.test(x[0])).map((x) => x[0]).sort(); return all(/id/i.test(r[0].join(",")) || "no header row", J(ids) === J(["2", "4", "6"]) || "it holds orders " + ids.join(", ") + " instead of 2, 4, 6"); },
    fake: () => [use(["read_file", { path: "orders.csv" }]), use(["write_file", { path: "big-orders.csv", content: "id,customer,total\n" + ORDERS.filter((o) => Number(o[2]) > 100).map((r) => r.join(",")).join("\n") + "\n" }]), t("Wrote 3 orders.")] },
  { id: "json-to-csv", kind: "data", prompt: "Convert people.json in my working folder to people.csv with a header row.",
    setup: (d) => put(d, "people.json", J(PEOPLE, null, 2)),
    check: (d) => { const r = csvRows(rd(d, "people.csv")); if (!r.length) return "people.csv was not created"; return all(["name", "age", "city"].every((c) => r[0].map((x) => x.toLowerCase()).includes(c)) || "the header is " + r[0].join(","), r.length === 5 || "it has " + (r.length - 1) + " data rows instead of 4", /New York/.test(rd(d, "people.csv")) || "New York is missing"); },
    fake: () => [use(["read_file", { path: "people.json" }]), use(["write_file", { path: "people.csv", content: "name,age,city\n" + PEOPLE.map((p) => [p.name, p.age, p.city].join(",")).join("\n") + "\n" }]), t("Wrote people.csv.")] },
  { id: "chart", kind: "data", quick: true, prompt: "Make a bar chart of the visitors per month in monthly.csv, saved as chart.png in my working folder.",
    setup: (d) => put(d, "monthly.csv", "month,visitors\n" + MONTHS.map((r) => r.join(",")).join("\n") + "\n"),
    check: (d) => png(d, "chart.png"),
    fake: () => [use(["make_chart", { path: "chart.png", type: "bar", title: "Visitors per month", labels: MONTHS.map((m) => m[0]), series: [{ name: "Visitors", values: MONTHS.map((m) => m[1]) }] }]), t("Created chart.png.")] },
  { id: "summary-file", kind: "text", prompt: "Write a 3-sentence summary of article.txt into summary.txt in my working folder.",
    setup: (d) => put(d, "article.txt", ARTICLE),
    check: (d) => { const s = rd(d, "summary.txt"); if (s === null) return "summary.txt was not created"; const n = (s.match(/[.!?](\s|$)/g) || []).length; return all(s.length > 60 && s.length < 900 || "the summary is " + s.length + " characters", /bee/i.test(s) || "the summary is not about bees", n >= 2 && n <= 5 || "it has " + n + " sentences"); },
    fake: () => [use(["read_file", { path: "article.txt" }]), use(["write_file", { path: "summary.txt", content: "Honeybees live in large colonies and pollinate many crops. Mites, pesticides and fewer wild flowers have weakened them. Beekeepers and towns are helping, which also protects our food." }]), t("Wrote summary.txt.")] },
  { id: "todo-extract", kind: "text", prompt: "Collect every TODO line from notes.md in my working folder into a new file todos.txt, one per line.",
    setup: (d) => put(d, "notes.md", "# Notes\n\nMet with Sam about the launch.\nTODO: send the budget to Kim\nLunch was good.\nTODO: book the train to Leeds\n- TODO: renew the domain\nThe weather was fine.\n"),
    check: (d) => { const s = rd(d, "todos.txt"); if (s === null) return "todos.txt was not created"; return all(...["send the budget", "book the train", "renew the domain"].map((x) => s.includes(x) || "missing: " + x), !/Lunch|weather|Met with/.test(s) || "lines that are not TODOs were copied"); },
    fake: () => [use(["read_file", { path: "notes.md" }]), use(["write_file", { path: "todos.txt", content: "send the budget to Kim\nbook the train to Leeds\nrenew the domain\n" }]), t("Wrote 3 TODOs.")] },
  { id: "fix-typo", kind: "text", prompt: "Fix the spelling mistakes in letter.txt in my working folder. Only spelling; keep everything else as it is.",
    setup: (d) => put(d, "letter.txt", LETTER),
    check: (d) => { const s = rd(d, "letter.txt") || ""; return all(...["writing", "receive", "supposed"].map((w) => s.includes(w) || w + " is not fixed"), !/writting|recieve|suposed/.test(s) || "a typo is left", /Dear Mr Smith/.test(s) && /Kind regards/.test(s) || "other text was changed"); },
    fake: () => [use(["read_file", { path: "letter.txt" }]), use(["write_file", { path: "letter.txt", content: LETTER.replace("writting", "writing").replace("recieve", "receive").replace("suposed", "supposed") }]), t("Fixed 3 spelling mistakes.")] },
  { id: "merge-texts", kind: "text", prompt: "Combine part1.txt, part2.txt and part3.txt from my working folder, in that order, into one file all.txt.",
    setup: (d) => ["Alpha line.", "Bravo line.", "Charlie line."].forEach((s, k) => put(d, `part${k + 1}.txt`, s + "\n")),
    check: (d) => { const s = rd(d, "all.txt"); if (s === null) return "all.txt was not created"; const i = ["Alpha", "Bravo", "Charlie"].map((w) => s.indexOf(w)); return (i.every((x) => x >= 0) && i[0] < i[1] && i[1] < i[2]) || "all.txt does not hold the three parts in order"; },
    fake: () => [use(["read_files", { paths: ["part1.txt", "part2.txt", "part3.txt"] }]), use(["write_file", { path: "all.txt", content: "Alpha line.\nBravo line.\nCharlie line.\n" }]), t("Wrote all.txt.")] },
  { id: "search-text", kind: "text", prompt: "Which file in my working folder mentions the meeting room, and which room is it?",
    setup: (d) => { put(d, "notes/monday.txt", "Project sync moved. The meeting room is B-214 this week."); put(d, "notes/tuesday.txt", "Lunch with the design team."); put(d, "notes/friday.txt", "Remember to water the plants."); },
    check: (d, a) => all(say(a, /monday/i, "monday.txt"), say(a, /B-?214/i, "room B-214")),
    fake: () => [use(["search_files", { query: "meeting room", path: "." }]), t("notes/monday.txt says the meeting room is B-214.")] },
  { id: "write-email", kind: "text", prompt: "Write a short, polite email to my landlord asking them to fix the heating, and save it as email.txt in my working folder.",
    check: (d) => { const s = rd(d, "email.txt"); if (s === null) return "email.txt was not created"; return all(/heating/i.test(s) || "it does not mention the heating", /\b(dear|hello|hi)\b/i.test(s) || "no greeting", s.length > 80 && s.length < 3000 || "it is " + s.length + " characters long"); },
    fake: () => [use(["write_file", { path: "email.txt", content: "Subject: Heating repair\n\nDear landlord,\n\nThe heating in my flat has stopped working. Could you please arrange a repair this week?\n\nThank you,\nAlex\n" }]), t("Saved email.txt.")] },
  { id: "calc-compound", kind: "calc", prompt: "If I put 2,500 euros in a savings account at 3.2% interest per year, compounded yearly, how much will I have after 7 years? Round to cents.",
    check: (d, a) => near(a, 3116.72, 0.011), fake: () => [t("You will have 3,116.72 euros.")] },
  { id: "calc-dates", kind: "calc", quick: true, prompt: "How many days are there from 2026-03-14 to 2026-12-25?",
    check: (d, a) => near(a, 286, 0), fake: () => [t("There are 286 days.")] },
  { id: "calc-split", kind: "calc", prompt: "Three friends split a restaurant bill of 187.50 euros plus a 12% tip equally. How much does each pay? Round to cents.",
    check: (d, a) => near(a, 70, 0.001), fake: () => [t("Each pays 70.00 euros.")] },
  { id: "web-capital", kind: "web", quick: true, prompt: "Search the web: what is the capital city of Australia? Give the source link.",
    check: (d, a, ctx) => all(say(a, /Canberra/, "Canberra"), say(a, /https?:\/\/|www\.|\.\w{2,3}\//, "a source link"), usedWeb(a, ctx)), fake: () => [t("The capital of Australia is Canberra. Source: https://en.wikipedia.org/wiki/Canberra")] },
  { id: "web-node-lts", kind: "web", prompt: "Look up online which version line of Node.js is the current LTS (long-term support) release, and give the source link.",
    check: (d, a, ctx) => all(say(a, /\b(v|version |Node(\.js)? )?\d{2}\b/i, "a version number"), say(a, /https?:\/\/|nodejs\.org/i, "a source link"), usedWeb(a, ctx)), fake: () => [t("The current LTS line is Node.js 24. Source: https://nodejs.org/en/about/previous-releases")] },
  { id: "python-primes", kind: "code", prompt: "Write a Python script primes.py in my working folder that prints the first 10 prime numbers, one per line.",
    check: async (d, a, ctx) => { const s = rd(d, "primes.py"); if (s === null) return "primes.py was not created"; if (!ctx.sandbox) return /print/.test(s) || "the script prints nothing";
      const r = await ctx.sandbox("python", s); return String(r.stdout || "").trim().split(/\s+/).join(",") === "2,3,5,7,11,13,17,19,23,29" || "running it printed: " + String(r.stdout || r.stderr || r.error || "").slice(0, 80); },
    fake: () => [use(["write_file", { path: "primes.py", content: "n, found = 2, []\nwhile len(found) < 10:\n    if all(n % p for p in found):\n        found.append(n)\n    n += 1\nprint(*found, sep='\\n')\n" }]), t("Wrote primes.py.")] },
];

// ---------- the scripted stand-in OmniRoute (--fake): every role answers like a working model would
function fakeOmniRoute() {
  const S = { task: null, sabotage: false, calls: 0 }; let n = 0;
  const route = (k) => ({ complexity: "simple", tools: !["calc", "web"].includes(k), parallel: false, compute: k === "calc", web: k === "web", reason: "scripted" });
  const reply = (body) => {
    const sys = String(typeof body.system === "string" ? body.system : J(body.system || "")), msgs = body.messages || [];
    if (/Classify the user's request for a router/.test(sys)) return t(J(route(S.task ? S.task.kind : "files")));
    if (/You prepare a user's request/.test(sys)) return t("CLEAR");
    if (/You maintain a long-term memory/.test(sys)) return t('{"memories":[],"skill":null}');
    if (/You review ONE action/.test(sys)) return t('{"verdict":"safe","risk":"low","reason":"scripted"}');
    if (/You classify a user request for a routing system/.test(sys)) return t('{"protected":false,"category":""}');
    if (/You split a task into/.test(sys)) return t('{"parallel":false}');
    if (/You compare several independent answers/.test(sys)) return t('{"agree":true,"best":0,"conflicts":[]}');
    if (/senior advisor/.test(sys)) return t('{"plan":"1. Do the task.","criteria":[],"tests":""}');
    if (S.sabotage || !S.task) return t("All done.");
    const steps = S.task.fake(), k = msgs.filter((m) => m.role === "assistant").length;
    return k < steps.length ? steps[k] : t("Done.");
  };
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const j = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(J(o)); };
      if (req.url === "/api/settings/require-login") return j({ requireLogin: false });
      if (req.url === "/v1/models") return j({ data: ["groq/openai/gpt-oss-120b", "gemini/gemini-3.1-flash-lite", "claude-first"].map((id) => ({ id })) });
      if (req.url === "/api/pricing") return j({});
      if (req.url !== "/v1/messages" || req.method !== "POST") return j({ error: { message: "not found" } }, 404);
      let body = {}; try { body = JSON.parse(b); } catch {}
      S.calls++; const r = reply(body), tools = (r.tools || []).filter(() => (body.tools || []).length), text = r.text || "";
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type, o) => res.write(`event: ${type}\ndata: ${J({ type, ...o })}\n\n`);
      ev("message_start", { message: { id: "msg_" + ++n, type: "message", role: "assistant", model: body.model, content: [], usage: { input_tokens: Math.ceil(b.length / 4), output_tokens: 0 } } });
      let i = 0;
      if (text) { ev("content_block_start", { index: i, content_block: { type: "text", text: "" } }); ev("content_block_delta", { index: i, delta: { type: "text_delta", text } }); ev("content_block_stop", { index: i++ }); }
      for (const u of tools) { ev("content_block_start", { index: i, content_block: { type: "tool_use", id: "toolu_" + ++n, name: u.name, input: {} } }); ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: J(u.input) } }); ev("content_block_stop", { index: i++ }); }
      ev("message_delta", { delta: { stop_reason: tools.length ? "tool_use" : "end_turn" }, usage: { output_tokens: Math.ceil((text.length + J(tools).length) / 4) } });
      ev("message_stop", {}); res.end();
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ S, url: "http://127.0.0.1:" + server.address().port, close: () => server.close() })));
}

// ---------- in the page: run one request as a person would, approve what still asks, and answer questions with "decide yourself"
const PAGE = `(() => {
  window.BENCH = { asked: 0 };
  setInterval(() => { if (!busy) return;
    document.querySelectorAll(".act button[data-a=y]").forEach((b) => { BENCH.asked++; b.click(); });
    document.querySelectorAll(".askq:not(.answered)").forEach((q) => { if (q.dataset.bench) return; q.dataset.bench = "1"; BENCH.asked++; q.querySelector("input").value = "I can't answer right now. Use your best judgment, say what you assumed, and finish the task."; q.querySelector("[data-send]").click(); });
  }, 700);
  LS.set("orc.settings", { ...(LS.get("orc.settings") || {}), learn: false });
  window.benchRun = async (prompt, dir) => {
    CFG = { ...CFG, approval: "bypass", cwd: dir, roots: [dir] }; await saveCfg();
    newChat(); $("#pc").checked = true; BENCH.asked = 0;
    const one = async (q) => { input.value = q; await send(); const m = history[history.length - 1]; return String((m && m.content) || ""); };
    let answer = await one(prompt);
    if (answer.length < 400 && /\\?\\s*$/.test(answer) && !/\\[Actions this turn:/.test(answer)) { BENCH.asked++; answer = await one("I can't answer questions right now. Go ahead with your best assumption and finish the task."); }
    return { answer, calls: USAGE.calls, tokens: USAGE.in + USAGE.out, asked: BENCH.asked, tools: [...col.querySelectorAll(".tooltn .who span")].map((s) => s.textContent.replace(/^Action · /, "")) };
  };
  return true;
})()`;

if (flag("--list")) { for (const k of TASKS) console.log(k.id.padEnd(18) + k.prompt); process.exit(0); }
let url = process.env.OMNIROUTE_URL || "http://127.0.0.1:20128", key = "", fake = null;
if (FAKE) { fake = await fakeOmniRoute(); url = fake.url; key = "scripted-key"; }
else {
  const keyFile = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OmniRouteChat", "omniroute-key.txt");
  key = process.env.OMNIROUTE_API_KEY || (() => { try { return fs.readFileSync(keyFile, "utf8").trim(); } catch { return ""; } })();
  if (!key) { console.error("No OmniRoute API key. Set OMNIROUTE_API_KEY, or save the key in OmniGPT (Settings > Connection) first."); process.exit(2); }
  try { const r = await fetch(url + "/v1/models", { headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error("it answered HTTP " + r.status); }
  catch (e) { console.error("OmniRoute does not answer at " + url + ": " + (e.message || e) + ". Start OmniRoute (or OmniGPT) first, or set OMNIROUTE_URL."); process.exit(2); }
}
const only = opt("only") ? opt("only").split(",") : null;
const unknown = (only || []).filter((x) => !TASKS.some((k) => k.id === x));
if (unknown.length) { console.error("Unknown task: " + unknown.join(", ") + ". See --list."); process.exit(2); }
const tasks = TASKS.filter((k) => (only ? only.includes(k.id) : !QUICK || k.quick));
const root = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-bench-" + process.pid); // only these throwaway folders are allowed to the agents
const results = [];
let app = null, failed = 0;
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
try {
  const browser = WIN ? null : findBrowser(); // charts and PDFs are drawn by a headless browser
  app = await openApp({ port: "20242", env: { OMNIROUTE_URL: url, OMNIROUTE_API_KEY: key, ...(browser ? { OMNIGPT_BROWSER: browser } : {}) } });
  const E = (js, ms) => app.evaluate(js, ms);
  await E(PAGE);
  const token = await E("TOKEN"), sbx = await E("SBX.available===true");
  const ctx = { fake: FAKE, sandbox: sbx ? async (language, code) => (await fetch(app.base + "/api/sandbox", { method: "POST", headers: { "x-app-token": token, "content-type": "application/json" }, body: J({ language, code, timeout: 10 }) })).json() : null };
  console.log(`OmniGPT benchmark · ${FAKE ? "scripted stand-in OmniRoute" : "OmniRoute at " + url} · ${tasks.length} tasks · up to ${TIMEOUT} s each`);
  console.log("Models: " + Object.entries(await E("JSON.parse(JSON.stringify(TIERS))")).map(([k, v]) => k + " " + v.join(", ")).join(" | ") + "\n");
  console.log("Task               Result   Seconds  Calls  Tokens  Note");
  const runOne = async (k) => {
    const d = path.join(root, k.id); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); if (k.setup) k.setup(d);
    if (fake) fake.S.task = k;
    const t0 = Date.now(); let r = null, why = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; E("(ctrl&&ctrl.abort(),true)").catch(() => {}); }, TIMEOUT * 1000);
    try { r = await E(`benchRun(${J(k.prompt)}, ${J(d)})`, (TIMEOUT + 120) * 1000); } catch (e) { why = "the page failed: " + String(e.message || e).slice(0, 120); }
    clearTimeout(timer);
    let ok = false;
    if (r) { try { const v = await k.check(d, r.answer, { ...ctx, tools: r.tools }); ok = v === true; why = ok ? "" : String(v || "check failed"); } catch (e) { why = "check error: " + e.message; } }
    if (timedOut) { ok = false; why = "timed out after " + TIMEOUT + " s" + (why ? "; " + why : ""); }
    return { id: k.id, kind: k.kind, pass: ok, why, seconds: Math.round((Date.now() - t0) / 100) / 10, calls: r ? r.calls : 0, tokens: r ? r.tokens : 0, asked: r ? r.asked : 0, tools: r ? r.tools : [], answer: r ? r.answer.slice(0, 600) : "" };
  };
  for (const k of tasks) {
    let x;
    if (k.win && !WIN) x = { id: k.id, kind: k.kind, pass: null, why: "skipped: needs Windows", seconds: 0, calls: 0, tokens: 0, asked: 0, tools: [], answer: "" };
    else x = await runOne(k);
    if (x.pass === false) failed++;
    results.push(x);
    console.log(`${x.id.padEnd(18)} ${x.pass === null ? "skip" : x.pass ? "PASS" : "FAIL"}   ${String(x.seconds).padStart(7)}  ${String(x.calls).padStart(5)}  ${fmtTok(x.tokens).padStart(6)}  ${(x.asked ? "answered " + x.asked + " question" + (x.asked > 1 ? "s" : "") + " for the user. " : "") + x.why}`.trimEnd());
  }
  if (FAKE && QUICK) { // the harness must also notice a model that only claims to have done the work
    fake.S.sabotage = true; const x = await runOne(TASKS.find((k) => k.id === "docx-heading")); fake.S.sabotage = false;
    console.log(x.pass === false ? "BROKEN-FAKE-CAUGHT: a model that only says it is done fails the check (" + x.why + ")" : "FAIL  a model that did nothing still passed docx-heading");
    if (x.pass !== false) failed++;
  }
  const done = results.filter((x) => x.pass !== null), sum = (k) => done.reduce((s, x) => s + x[k], 0), passed = done.filter((x) => x.pass).length;
  const totals = { passed, failed: done.length - passed, skipped: results.length - done.length, seconds: Math.round(sum("seconds")), calls: sum("calls"), tokens: sum("tokens") };
  console.log(`\nTotal: ${passed} of ${done.length} passed${totals.skipped ? `, ${totals.skipped} skipped` : ""} · ${totals.seconds} s · ${totals.calls} model calls · ${fmtTok(totals.tokens)} tokens`);
  for (const kd of [...new Set(done.map((x) => x.kind))]) { const g = done.filter((x) => x.kind === kd); console.log(`  ${kd.padEnd(6)} ${g.filter((x) => x.pass).length} of ${g.length}`); }
  const report = opt("report") || (FAKE ? path.join(os.tmpdir(), "omnigpt-bench-report-fake.json") : path.join(here, "bench-report.json"));
  fs.writeFileSync(report, J({ when: new Date().toISOString(), omniroute: FAKE ? "scripted" : url, models: await E("JSON.parse(JSON.stringify(TIERS))"), timeoutSeconds: TIMEOUT, totals, tasks: results }, null, 2));
  console.log("Report: " + report);
  if (!failed) console.log(`All ${done.length} tasks passed.`);
} catch (e) { failed++; console.error("Benchmark error: " + (e.stack || e)); }
if (app) await app.close();
if (fake) fake.close();
if (!flag("--keep")) fs.rmSync(root, { recursive: true, force: true }); else console.log("Task folders kept in " + root);
process.exit(failed ? 1 : 0);
