// Document builder for make_document: Markdown (and tables / slide lists) to HTML, Word (.docx), Excel (.xlsx) and
// PowerPoint (.pptx), written directly as Office Open XML packages. No Office installation is needed.
import { zipBuild } from "./zip.mjs";

const x = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

// ---------- Markdown to blocks
// blocks: {t:"h",level,text} {t:"p",text} {t:"list",ordered,items:[{text,level}]} {t:"table",rows:[[...]]} {t:"code",text} {t:"quote",text} {t:"hr"} {t:"pagebreak"}
export function parseMarkdown(md) {
  const L = String(md ?? "").replace(/\r\n?/g, "\n").split("\n"), out = [];
  for (let i = 0; i < L.length; ) {
    const line = L[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^\s*```/.exec(line))) { const buf = []; i++; while (i < L.length && !/^\s*```/.test(L[i])) buf.push(L[i++]); i++; out.push({ t: "code", text: buf.join("\n") }); continue; }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { out.push({ t: "h", level: m[1].length, text: m[2] }); i++; continue; }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { out.push({ t: "hr" }); i++; continue; }
    if (/^\s*<!--\s*pagebreak\s*-->\s*$/i.test(line) || /^\\pagebreak\s*$/.test(line)) { out.push({ t: "pagebreak" }); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < L.length && /^\s*\|.*\|\s*$/.test(L[i])) { const r = L[i++].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()); if (!r.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(r); }
      out.push({ t: "table", rows }); continue;
    }
    if (/^\s*>/.test(line)) { const buf = []; while (i < L.length && /^\s*>/.test(L[i])) buf.push(L[i++].replace(/^\s*>\s?/, "")); out.push({ t: "quote", text: buf.join(" ") }); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line), items = [];
      while (i < L.length && (m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(L[i]))) { items.push({ text: m[3], level: Math.min(2, Math.floor(m[1].replace(/\t/g, "    ").length / 2)) }); i++; }
      out.push({ t: "list", ordered, items }); continue;
    }
    const buf = [line.trim()]; i++;
    while (i < L.length && L[i].trim() && !/^(#{1,6}\s|\s*```|\s*\||\s*>|\s*([-*+]|\d+[.)])\s+|\s*(---+|\*\*\*+)\s*$)/.test(L[i])) buf.push(L[i++].trim());
    out.push({ t: "p", text: buf.join(" ") });
  }
  return out;
}
// inline Markdown to runs: [{text, b, i, code, link}]
export function runs(s) {
  const out = [], re = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)\3|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0, m; s = String(s ?? "");
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    if (m[2] !== undefined) out.push(...runs(m[2]).map((r) => ({ ...r, b: true })));
    else if (m[4] !== undefined) out.push(...runs(m[4]).map((r) => ({ ...r, i: true })));
    else if (m[5] !== undefined) out.push({ text: m[5], code: true });
    else out.push({ text: m[6], link: m[7] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.filter((r) => r.text);
}
const plain = (s) => runs(s).map((r) => r.text).join("");

// ---------- HTML (also the source for PDF)
export function toHtml(blocks, title) {
  const inl = (s) => runs(s).map((r) => { let h = x(r.text); if (r.code) h = `<code>${h}</code>`; if (r.b) h = `<strong>${h}</strong>`; if (r.i) h = `<em>${h}</em>`; if (r.link) h = `<a href="${x(r.link)}">${h}</a>`; return h; }).join("");
  const body = blocks.map((b) => {
    if (b.t === "h") return `<h${b.level}>${inl(b.text)}</h${b.level}>`;
    if (b.t === "p") return `<p>${inl(b.text)}</p>`;
    if (b.t === "quote") return `<blockquote>${inl(b.text)}</blockquote>`;
    if (b.t === "code") return `<pre><code>${x(b.text)}</code></pre>`;
    if (b.t === "hr") return "<hr>";
    if (b.t === "pagebreak") return '<div style="page-break-after:always"></div>';
    if (b.t === "table") return `<table>${b.rows.map((r, k) => `<tr>${r.map((c) => k ? `<td>${inl(c)}</td>` : `<th>${inl(c)}</th>`).join("")}</tr>`).join("")}</table>`;
    if (b.t === "list") { let h = "", depth = -1; const tag = b.ordered ? "ol" : "ul"; for (const it of b.items) { while (depth < it.level) { h += `<${tag}>`; depth++; } while (depth > it.level) { h += `</${tag}>`; depth--; } h += `<li>${inl(it.text)}</li>`; } while (depth-- >= 0) h += `</${tag}>`; return h; }
    return "";
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${x(title || "Document")}</title><style>
body{font-family:"Segoe UI",Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;color:#1f1f1f;max-width:46em;margin:2em auto;padding:0 1.5em}
h1,h2,h3{line-height:1.25;margin:1.2em 0 .4em}h1{font-size:22pt}h2{font-size:16pt}h3{font-size:13pt}
table{border-collapse:collapse;margin:.8em 0;width:100%}th,td{border:1px solid #bbb;padding:5px 8px;text-align:left;vertical-align:top}th{background:#f0f0f0}
pre{background:#f5f5f5;padding:10px;border-radius:4px;white-space:pre-wrap;font-size:9.5pt}code{font-family:Consolas,monospace}
blockquote{border-left:3px solid #ccc;margin:.8em 0;padding:.2em 1em;color:#555}hr{border:0;border-top:1px solid #ccc;margin:1.5em 0}
@page{margin:2cm}@media print{body{margin:0;max-width:none}}
</style></head><body>${title ? `<h1>${x(title)}</h1>\n` : ""}${body}</body></html>`;
}

// ---------- shared package parts
const CORE = (title) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(title || "")}</dc:title><dc:creator>OmniGPT</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created></cp:coreProperties>`;
const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>OmniGPT</Application></Properties>`;
const ROOT_RELS = (main) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
const TYPES = (overrides) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
const OD = "application/vnd.openxmlformats-officedocument";

// ---------- Word
export function toDocx(blocks, title) {
  const links = [], nums = [];
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const run = (r, extra = "") => { const p = `${r.b ? "<w:b/>" : ""}${r.i ? "<w:i/>" : ""}${r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ""}${extra}`; return `<w:r>${p ? `<w:rPr>${p}</w:rPr>` : ""}<w:t xml:space="preserve">${x(r.text)}</w:t></w:r>`; };
  const inl = (s) => runs(s).map((r) => { if (!r.link) return run(r); links.push(r.link); return `<w:hyperlink r:id="rIdL${links.length}">${run(r, '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>`; }).join("");
  const para = (style, inner, extra = "") => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>${inner}</w:p>`;
  const body = [];
  if (title) body.push(para("Title", run({ text: title })));
  for (const b of blocks) {
    if (b.t === "h") body.push(para("Heading" + Math.min(b.level, 3), inl(b.text)));
    else if (b.t === "p") body.push(para("", inl(b.text)));
    else if (b.t === "quote") body.push(para("Quote", inl(b.text)));
    else if (b.t === "code") body.push(para("Code", b.text.split("\n").map((l, k) => (k ? "<w:r><w:br/></w:r>" : "") + `<w:r><w:t xml:space="preserve">${x(l)}</w:t></w:r>`).join("")));
    else if (b.t === "hr") body.push(para("", "", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr>'));
    else if (b.t === "pagebreak") body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    else if (b.t === "list") { nums.push(b.ordered ? 2 : 1); const id = nums.length; for (const it of b.items) body.push(para("ListParagraph", inl(it.text), `<w:numPr><w:ilvl w:val="${it.level}"/><w:numId w:val="${id}"/></w:numPr>`)); }
    else if (b.t === "table") {
      const cols = Math.max(...b.rows.map((r) => r.length), 1), w = Math.floor(9360 / cols);
      body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="' + w + '"/>'.repeat(cols)}</w:tblGrid>` +
        b.rows.map((r, k) => `<w:tr>${k === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${Array.from({ length: cols }, (_, c) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${k === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F0F0F0"/>' : ""}</w:tcPr><w:p>${k === 0 ? runs(r[c] || "").map((q) => run({ ...q, b: true })).join("") : inl(r[c] || "")}</w:p></w:tc>`).join("")}</w:tr>`).join("") + "</w:tbl>");
      body.push("<w:p/>");
    }
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const lvl = (k, fmt, text) => `<w:lvl w:ilvl="${k}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (k + 1)}" w:hanging="360"/></w:pPr>${fmt === "bullet" ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>' : ""}</w:lvl>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2].map((k) => lvl(k, "bullet", "")).join("")}</w:abstractNum><w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2].map((k) => lvl(k, ["decimal", "lowerLetter", "lowerRoman"][k], `%${k + 1}.`)).join("")}</w:abstractNum>${nums.map((a, k) => `<w:num w:numId="${k + 1}"><w:abstractNumId w:val="${a}"/>${a === 2 ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>' : ""}</w:num>`).join("")}</w:numbering>`;
  const st = (id, name, type, ppr, rpr, extra = "") => `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${type === "paragraph" && id !== "Normal" ? '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' : ""}${extra}<w:qFormat/>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}</w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    st("Title", "Title", "paragraph", '<w:spacing w:after="240"/>', '<w:sz w:val="52"/><w:szCs w:val="52"/>') +
    st("Heading1", "heading 1", "paragraph", '<w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/>', '<w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/>') +
    st("Heading2", "heading 2", "paragraph", '<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/>', '<w:b/><w:color w:val="2F5496"/><w:sz w:val="26"/><w:szCs w:val="26"/>') +
    st("Heading3", "heading 3", "paragraph", '<w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/>', '<w:b/><w:sz w:val="23"/><w:szCs w:val="23"/>') +
    st("ListParagraph", "List Paragraph", "paragraph", '<w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/>', "") +
    st("Quote", "Quote", "paragraph", '<w:ind w:left="720"/>', '<w:i/><w:color w:val="595959"/>') +
    st("Code", "Code", "paragraph", '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/>', '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/>') +
    `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join("")}</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${links.map((u, k) => `<Relationship Id="rIdL${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${x(u)}" TargetMode="External"/>`).join("")}</Relationships>`;
  return zipBuild([
    { name: "[Content_Types].xml", data: TYPES([["/word/document.xml", OD + ".wordprocessingml.document.main+xml"], ["/word/styles.xml", OD + ".wordprocessingml.styles+xml"], ["/word/numbering.xml", OD + ".wordprocessingml.numbering+xml"]]) },
    { name: "_rels/.rels", data: ROOT_RELS("word/document.xml") },
    { name: "docProps/core.xml", data: CORE(title) }, { name: "docProps/app.xml", data: APP },
    { name: "word/document.xml", data: doc }, { name: "word/styles.xml", data: styles }, { name: "word/numbering.xml", data: numbering },
    { name: "word/_rels/document.xml.rels", data: docRels },
  ]);
}

// ---------- Excel
const colName = (n) => { let s = ""; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const sheetName = (s, k, used) => { let n = String(s || "Sheet" + (k + 1)).replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet" + (k + 1); let b = n, j = 2; while (used.has(n.toLowerCase())) n = b.slice(0, 28) + " " + j++; used.add(n.toLowerCase()); return n; };
// sheets: [{ name, rows: [[cell, ...], ...], header?: true }]; a cell is a number, boolean, string, or "=FORMULA"
export function toXlsx(sheets, title) {
  const used = new Set(), list = (sheets.length ? sheets : [{ name: "Sheet1", rows: [] }]).map((s, k) => ({ ...s, name: sheetName(s.name, k, used), rows: (s.rows || []).map((r) => (Array.isArray(r) ? r : Object.values(r || {}))) }));
  const ws = list.map((s, k) => {
    const header = s.header !== false && s.rows.length > 1, cols = Math.max(0, ...s.rows.map((r) => r.length));
    const width = Array.from({ length: cols }, (_, c) => Math.min(60, Math.max(8, ...s.rows.map((r) => String(r[c] ?? "").length + 2))));
    const cell = (v, r, c) => {
      const ref = colName(c) + (r + 1), st = header && r === 0 ? ' s="1"' : "";
      if (v === null || v === undefined || v === "") return "";
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
      if (typeof v === "boolean") return `<c r="${ref}" t="b"${st}><v>${v ? 1 : 0}</v></c>`;
      const t = String(v);
      if (/^=[^=]/.test(t)) return `<c r="${ref}"${st}><f>${x(t.slice(1))}</f></c>`;
      if (/^-?\d+(\.\d+)?$/.test(t.trim()) && t.trim().length < 16 && !/^0\d/.test(t.trim())) return `<c r="${ref}"${st}><v>${Number(t)}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${x(t)}</t></is></c>`;
    };
    const last = cols ? colName(cols - 1) + s.rows.length : "A1";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"${k === 0 ? ' tabSelected="1"' : ""}>${header ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ""}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${width.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : ""}<sheetData>${s.rows.map((r, k) => `<row r="${k + 1}">${r.map((v, c) => cell(v, k, c)).join("")}</row>`).join("")}</sheetData>${header && cols ? `<autoFilter ref="A1:${last}"/>` : ""}</worksheet>`;
  });
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${list.map((s, k) => `<sheet name="${x(s.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join("")}</sheets>${list.some((s, k) => s.rows.length > 1 && s.header !== false) ? `<definedNames>${list.map((s, k) => s.rows.length > 1 && s.header !== false ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${k}" hidden="1">'${x(s.name).replace(/'/g, "''")}'!$A$1:$${colName(Math.max(0, ...s.rows.map((r) => r.length)) - 1)}$${s.rows.length}</definedName>` : "").join("")}</definedNames>` : ""}</workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((s, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join("")}<Relationship Id="rIdSt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0F0F0"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return zipBuild([
    { name: "[Content_Types].xml", data: TYPES([["/xl/workbook.xml", OD + ".spreadsheetml.sheet.main+xml"], ["/xl/styles.xml", OD + ".spreadsheetml.styles+xml"], ...list.map((s, k) => [`/xl/worksheets/sheet${k + 1}.xml`, OD + ".spreadsheetml.worksheet+xml"])]) },
    { name: "_rels/.rels", data: ROOT_RELS("xl/workbook.xml") },
    { name: "docProps/core.xml", data: CORE(title) }, { name: "docProps/app.xml", data: APP },
    { name: "xl/workbook.xml", data: wb }, { name: "xl/_rels/workbook.xml.rels", data: wbRels }, { name: "xl/styles.xml", data: styles },
    ...ws.map((d, k) => ({ name: `xl/worksheets/sheet${k + 1}.xml`, data: d })),
  ]);
}
// tables from Markdown or CSV text, for spreadsheets made from "content"
export function sheetsFromText(text) {
  const blocks = parseMarkdown(text), tables = blocks.filter((b) => b.t === "table");
  if (tables.length) { const heads = blocks.filter((b) => b.t === "h"); return tables.map((t, k) => ({ name: heads[k] ? plain(heads[k].text) : "Sheet" + (k + 1), rows: t.rows.map((r) => r.map(plain)) })); }
  const lines = String(text || "").replace(/\r/g, "").split("\n").filter((l) => l.trim()), sep = lines.length && (lines[0].split("\t").length > lines[0].split(",").length ? "\t" : lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",");
  const parse = (l) => { const out = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === sep) { out.push(cur); cur = ""; } else cur += c; } out.push(cur); return out; };
  return [{ name: "Sheet1", rows: lines.map(parse) }];
}

// ---------- PowerPoint (16:9, simple title + bullets slides on a blank layout)
const P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const SX = 12192000, SY = 6858000;
const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="OmniGPT"><a:themeElements><a:clrScheme name="OmniGPT"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="DC2626"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="D97706"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="OmniGPT"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="OmniGPT"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const textBox = (id, name, xo, yo, cx, cy, paras, anchor = "t") => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${xo}" y="${yo}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
const aRuns = (s, sz, extra = "") => runs(s).map((r) => `<a:r><a:rPr lang="en-US" sz="${sz}"${r.b || extra.includes("b") ? ' b="1"' : ""}${r.i ? ' i="1"' : ""} dirty="0">${r.code ? '<a:latin typeface="Consolas"/>' : ""}</a:rPr><a:t>${x(r.text)}</a:t></a:r>`).join("") || `<a:endParaRPr lang="en-US" sz="${sz}"/>`;
// slides: [{ title, bullets: [string | { text, level }], notes? }]
export function toPptx(slides, title) {
  const list = slides.length ? slides : [{ title: title || "Presentation", bullets: [] }];
  const xml = list.map((s, k) => {
    const items = (s.bullets || []).map((b) => (typeof b === "string" ? { text: b, level: 0 } : { text: String(b.text ?? ""), level: Math.min(2, Number(b.level) || 0) }));
    const cover = k === 0 && !items.length && list.length > 1, n = items.length;
    const sz = Math.max(1400, Math.min(2400, 2600 - n * 110));
    const body = items.map((b) => `<a:p><a:pPr marL="${342900 + b.level * 457200}" indent="-342900"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="${b.level ? "–" : "•"}"/></a:pPr>${aRuns(b.text, sz - b.level * 200)}</a:p>`).join("");
    const shapes = cover
      ? textBox(2, "Title", 838200, 2130000, SX - 1676400, 1470000, `<a:p><a:pPr algn="ctr"/>${aRuns(s.title || title || "", 4400, "b")}</a:p>`, "b") + (s.subtitle ? textBox(3, "Subtitle", 838200, 3700000, SX - 1676400, 900000, `<a:p><a:pPr algn="ctr"/>${aRuns(s.subtitle, 2200)}</a:p>`) : "")
      : textBox(2, "Title", 609600, 365125, SX - 1219200, 1100000, `<a:p>${aRuns(s.title || "", 3600, "b")}</a:p>`, "b") + (n ? textBox(3, "Content", 609600, 1600000, SX - 1219200, SY - 2100000, body) : "");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${P_NS}><p:cSld><p:spTree>${GRP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  });
  const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const rels = (inner) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
  const pres = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${P_NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${xml.map((_, k) => `<p:sldId id="${256 + k}" r:id="rId${10 + k}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${SX}" cy="${SY}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const master = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${P_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3600"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
  const layout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${P_NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const PT = OD + ".presentationml";
  return zipBuild([
    { name: "[Content_Types].xml", data: TYPES([["/ppt/presentation.xml", PT + ".presentation.main+xml"], ["/ppt/slideMasters/slideMaster1.xml", PT + ".slideMaster+xml"], ["/ppt/slideLayouts/slideLayout1.xml", PT + ".slideLayout+xml"], ["/ppt/theme/theme1.xml", OD + ".theme+xml"], ["/ppt/presProps.xml", PT + ".presProps+xml"], ["/ppt/viewProps.xml", PT + ".viewProps+xml"], ["/ppt/tableStyles.xml", PT + ".tableStyles+xml"], ...xml.map((_, k) => [`/ppt/slides/slide${k + 1}.xml`, PT + ".slide+xml"])]) },
    { name: "_rels/.rels", data: ROOT_RELS("ppt/presentation.xml") },
    { name: "docProps/core.xml", data: CORE(title) }, { name: "docProps/app.xml", data: APP },
    { name: "ppt/presentation.xml", data: pres },
    { name: "ppt/_rels/presentation.xml.rels", data: rels(rel("rId1", "slideMaster", "slideMasters/slideMaster1.xml") + rel("rId2", "theme", "theme/theme1.xml") + rel("rId3", "presProps", "presProps.xml") + rel("rId4", "viewProps", "viewProps.xml") + rel("rId5", "tableStyles", "tableStyles.xml") + xml.map((_, k) => rel(`rId${10 + k}`, "slide", `slides/slide${k + 1}.xml`)).join("")) },
    { name: "ppt/presProps.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentationPr ${P_NS}/>` },
    { name: "ppt/viewProps.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:viewPr ${P_NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>` },
    { name: "ppt/tableStyles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` },
    { name: "ppt/theme/theme1.xml", data: THEME },
    { name: "ppt/slideMasters/slideMaster1.xml", data: master },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: rels(rel("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml") + rel("rId2", "theme", "../theme/theme1.xml")) },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: layout },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: rels(rel("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")) },
    ...xml.map((d, k) => ({ name: `ppt/slides/slide${k + 1}.xml`, data: d })),
    ...xml.map((_, k) => ({ name: `ppt/slides/_rels/slide${k + 1}.xml.rels`, data: rels(rel("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")) })),
  ]);
}
// slides from Markdown: each # or ## heading starts a slide; list items and paragraphs become bullets
export function slidesFromText(text, title) {
  const blocks = parseMarkdown(text), slides = []; let cur = null;
  for (const b of blocks) {
    if (b.t === "h" && b.level <= 2) { cur = { title: plain(b.text), bullets: [] }; slides.push(cur); continue; }
    if (!cur) { cur = { title: title || "", bullets: [] }; slides.push(cur); }
    if (b.t === "list") cur.bullets.push(...b.items.map((it) => ({ text: it.text, level: it.level })));
    else if (b.t === "p" || b.t === "quote" || (b.t === "h" && b.level > 2)) cur.bullets.push({ text: b.text, level: 0 });
    else if (b.t === "table") cur.bullets.push(...b.rows.map((r) => ({ text: r.join("  |  "), level: 0 })));
    else if (b.t === "code") cur.bullets.push(...b.text.split("\n").filter(Boolean).slice(0, 12).map((l) => ({ text: "`" + l + "`", level: 0 })));
  }
  if (title && slides.length && slides[0].title !== title) slides.unshift({ title, bullets: [] });
  return slides;
}
