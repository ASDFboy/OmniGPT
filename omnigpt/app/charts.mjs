// make_chart: bar, line, pie and scatter charts drawn as SVG (no libraries). PNG files are rendered from the SVG by
// Edge in the background (tools.mjs). Colours follow one fixed, colour-blind-checked order; marks are thin, the grid is
// recessive, text is never in a series colour, and two or more series always get a legend.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const C = { surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const TYPES = new Set(["bar", "line", "pie", "scatter"]);
const x = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tw = (s, size) => String(s).length * size * 0.56; // text width estimate
const r1 = (n) => Math.round(n * 10) / 10;
const fmt = (v) => { const a = Math.abs(v); if (a >= 1e9) return r1(v / 1e9) + "B"; if (a >= 1e6) return r1(v / 1e6) + "M"; if (a >= 1e4) return r1(v / 1e3) + "K";
  return Number.isInteger(v) ? v.toLocaleString("en-US") : String(Math.round(v * 100) / 100); };
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

function niceTicks(lo, hi, count = 5) {
  if (lo === hi) { hi = lo === 0 ? 1 : lo + Math.abs(lo) * 0.5; lo = Math.min(0, lo); }
  const step0 = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(step0)), f = step0 / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step, t = [];
  for (let v = a; v <= b + step / 2; v += step) t.push(Math.round(v / step) * step);
  return t;
}
const num = (v) => { if (typeof v === "number") return v; const n = Number(String(v ?? "").replace(/[,%$€£\s]/g, "")); return Number.isFinite(n) ? n : NaN; };

// checks and normalises the input; throws a plain-language error for anything that cannot be drawn well
export function chartSpec(i) {
  const type = String(i.type || "").toLowerCase();
  if (!TYPES.has(type)) throw new Error("type must be bar, line, pie or scatter");
  let series = Array.isArray(i.series) ? i.series : [];
  if (!series.length && Array.isArray(i.values)) series = [{ name: i.title || "Value", values: i.values }];
  if (!series.length) throw new Error("series is required, e.g. [{name:\"Sales\", values:[3,5,2]}] (scatter: points [[x,y],...])");
  series = series.map((s, k) => ({ name: String((s && s.name) || `Series ${k + 1}`).slice(0, 60), values: Array.isArray(s && s.values) ? s.values.map(num) : [], points: Array.isArray(s && s.points) ? s.points.map((p) => [num(p && p[0]), num(p && p[1])]) : [] }));
  const labels = (Array.isArray(i.labels) ? i.labels : []).map((l) => String(l ?? ""));
  if (type === "scatter") {
    if (series.length > 3) throw new Error("a scatter chart shows at most 3 series (more cannot be told apart); split it into several charts");
    for (const s of series) { if (!s.points.length) throw new Error(`series "${s.name}" needs points [[x,y],...]`); if (s.points.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw new Error(`series "${s.name}" has a point that is not two numbers`); }
    if (series.reduce((n, s) => n + s.points.length, 0) > 20000) throw new Error("too many points (20000 max)");
  } else {
    const n = Math.max(...series.map((s) => s.values.length));
    if (!n) throw new Error("values are required");
    if (n > 500) throw new Error("too many values per series (500 max)");
    for (const s of series) if (s.values.some((v) => !Number.isFinite(v))) throw new Error(`series "${s.name}" has a value that is not a number`);
    while (labels.length < n) labels.push(String(labels.length + 1));
    if (type === "pie") {
      if (series.length > 1) throw new Error("a pie chart shows one series; use a bar chart to compare several");
      if (series[0].values.some((v) => v < 0)) throw new Error("a pie chart cannot show negative values");
      if (series[0].values.length < 2) throw new Error("a pie chart needs at least 2 slices");
    } else if (series.length > 8) throw new Error("at most 8 series in one chart; combine the smaller ones into \"Other\" or make several charts");
  }
  const width = Math.min(Math.max(Number(i.width) || 960, 320), 3000), height = Math.min(Math.max(Number(i.height) || 540, 240), 2000);
  return { type, series, labels: labels.slice(0, 500), title: String(i.title || "").slice(0, 120), subtitle: String(i.subtitle || "").slice(0, 200), x_label: String(i.x_label || "").slice(0, 80), y_label: String(i.y_label || "").slice(0, 80), stacked: !!i.stacked && type === "bar", width, height };
}

export function chartSvg(input) {
  const s = chartSpec(input), { width: W, height: H } = s, out = [];
  let top = 24;
  if (s.title) { out.push(`<text x="24" y="${top + 18}" font-size="20" font-weight="600" fill="${C.ink}">${x(s.title)}</text>`); top += 30; }
  if (s.subtitle) { out.push(`<text x="24" y="${top + 13}" font-size="13" fill="${C.ink2}">${x(s.subtitle)}</text>`); top += 22; }
  // legend: one row (wraps) of swatches with names, for two or more series and for pies
  const legend = (items) => { let lx = 24, ly = top + 12; for (const [k, name] of items.entries()) { const w = 18 + tw(name, 12.5) + 18; if (lx + w > W - 24 && lx > 24) { lx = 24; ly += 20; }
      out.push(`<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${SERIES[k % SERIES.length]}"/><text x="${lx + 16}" y="${ly}" font-size="12.5" fill="${C.ink2}">${x(name)}</text>`); lx += w; }
    top = ly + 14; };

  if (s.type === "pie") {
    let vals = s.series[0].values.map((v, k) => [s.labels[k], v]).sort((a, b) => b[1] - a[1]);
    if (vals.length > 8) { const rest = vals.slice(7).reduce((t, v) => t + v[1], 0); vals = [...vals.slice(0, 7), ["Other", rest]]; } // never a ninth colour
    const total = vals.reduce((t, v) => t + v[1], 0) || 1;
    legend(vals.map(([l, v]) => `${clip(l, 40)}  ${Math.round((v / total) * 1000) / 10}%`));
    const cx = W / 2, cy = top + (H - top - 16) / 2, R = Math.max(40, Math.min(W / 2 - 40, (H - top - 32) / 2));
    let a = -Math.PI / 2;
    for (const [k, [, v]] of vals.entries()) {
      const da = (v / total) * Math.PI * 2; if (da <= 0) continue;
      const a2 = a + da, big = da > Math.PI ? 1 : 0, p = (t) => `${r1(cx + R * Math.cos(t))} ${r1(cy + R * Math.sin(t))}`;
      out.push(da >= Math.PI * 2 - 1e-6 ? `<circle cx="${cx}" cy="${r1(cy)}" r="${r1(R)}" fill="${SERIES[k]}"/>`
        : `<path d="M ${r1(cx)} ${r1(cy)} L ${p(a)} A ${r1(R)} ${r1(R)} 0 ${big} 1 ${p(a2)} Z" fill="${SERIES[k]}" stroke="${C.surface}" stroke-width="2" stroke-linejoin="round"/>`);
      a = a2;
    }
    return wrap(out, W, H, s);
  }
  if (s.series.length > 1) legend(s.series.map((x) => x.name));

  // value range
  let xs = [], ys = [];
  if (s.type === "scatter") { for (const q of s.series) for (const [px, py] of q.points) { xs.push(px); ys.push(py); } }
  else if (s.stacked) { for (let k = 0; k < s.labels.length; k++) { let pos = 0, neg = 0; for (const q of s.series) { const v = q.values[k] || 0; v >= 0 ? (pos += v) : (neg += v); } ys.push(pos, neg); } }
  else for (const q of s.series) ys.push(...q.values);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (s.type === "bar" || lo > 0 && (hi - lo) / hi > 0.5) lo = Math.min(0, lo); // bars always start at zero
  if (s.type === "bar") hi = Math.max(0, hi);
  const yt = niceTicks(lo, hi), y0 = yt[0], y1 = yt[yt.length - 1];
  let left = 24 + (s.y_label ? 20 : 0) + Math.max(...yt.map((t) => tw(fmt(t), 12))) + 10;
  const many = s.type !== "scatter" && s.labels.length > 1 && s.labels.reduce((m, l) => Math.max(m, tw(l, 12)), 0) > (W - left - 32) / s.labels.length - 6;
  if (many) left = Math.max(left, Math.min(W / 3, tw(clip(s.labels[0], 18), 12) * 0.82 - (W - left - 32) / s.labels.length / 2 + 12)); // the first slanted label must not run off the left edge
  const bottom = H - 24 - (s.x_label ? 22 : 0) - (many ? Math.min(90, Math.max(...s.labels.map((l) => tw(clip(l, 18), 12))) * 0.7 + 14) : 22);
  const plotTop = top + 8, right = W - 32;
  const Y = (v) => bottom - ((v - y0) / (y1 - y0 || 1)) * (bottom - plotTop);
  for (const t of yt) {
    out.push(`<line x1="${r1(left)}" x2="${right}" y1="${r1(Y(t))}" y2="${r1(Y(t))}" stroke="${t === 0 ? C.axis : C.grid}" stroke-width="1"/>`);
    out.push(`<text x="${r1(left - 8)}" y="${r1(Y(t) + 4)}" font-size="12" fill="${C.muted}" text-anchor="end" style="font-variant-numeric:tabular-nums">${x(fmt(t))}</text>`);
  }
  if (s.y_label) out.push(`<text transform="translate(${30} ${r1((plotTop + bottom) / 2)}) rotate(-90)" font-size="12.5" fill="${C.ink2}" text-anchor="middle">${x(s.y_label)}</text>`);
  if (s.x_label) out.push(`<text x="${r1((left + right) / 2)}" y="${H - 20}" font-size="12.5" fill="${C.ink2}" text-anchor="middle">${x(s.x_label)}</text>`);

  if (s.type === "scatter") {
    let xl = Math.min(...xs), xh = Math.max(...xs); const xt = niceTicks(xl, xh); xl = xt[0]; xh = xt[xt.length - 1];
    const X = (v) => left + ((v - xl) / (xh - xl || 1)) * (right - left);
    for (const t of xt) out.push(`<text x="${r1(X(t))}" y="${r1(bottom + 18)}" font-size="12" fill="${C.muted}" text-anchor="middle">${x(fmt(t))}</text>`);
    for (const [k, q] of s.series.entries()) for (const [px, py] of q.points) out.push(`<circle cx="${r1(X(px))}" cy="${r1(Y(py))}" r="4.5" fill="${SERIES[k]}" stroke="${C.surface}" stroke-width="2"/>`);
    return wrap(out, W, H, s);
  }
  // category axis
  const n = s.labels.length, band = (right - left) / n, every = many ? Math.max(1, Math.ceil(n / Math.floor((right - left) / 16))) : 1;
  for (let k = 0; k < n; k += every) {
    const cx = left + band * (k + 0.5), l = x(clip(s.labels[k], many ? 18 : 40));
    out.push(many ? `<text transform="translate(${r1(cx)} ${r1(bottom + 14)}) rotate(-35)" font-size="12" fill="${C.muted}" text-anchor="end">${l}</text>` : `<text x="${r1(cx)}" y="${r1(bottom + 18)}" font-size="12" fill="${C.muted}" text-anchor="middle">${l}</text>`);
  }
  if (s.type === "bar") {
    const m = s.stacked ? 1 : s.series.length, thick = Math.max(2, Math.min(24, (band * 0.72 - (m - 1) * 2) / m)), group = m * thick + (m - 1) * 2;
    // 4px rounded data end, square at the baseline; a 2px surface gap between touching bars and stacked segments
    const bar = (bx, ya, yb, fill, round) => { const t = Math.min(ya, yb), b = Math.max(ya, yb), h = b - t; if (h < 0.5) return;
      const rr = round ? Math.min(4, h, thick / 2) : 0, up = yb <= ya;
      out.push(rr ? `<path d="${up ? `M ${r1(bx)} ${r1(b)} V ${r1(t + rr)} Q ${r1(bx)} ${r1(t)} ${r1(bx + rr)} ${r1(t)} H ${r1(bx + thick - rr)} Q ${r1(bx + thick)} ${r1(t)} ${r1(bx + thick)} ${r1(t + rr)} V ${r1(b)} Z` : `M ${r1(bx)} ${r1(t)} V ${r1(b - rr)} Q ${r1(bx)} ${r1(b)} ${r1(bx + rr)} ${r1(b)} H ${r1(bx + thick - rr)} Q ${r1(bx + thick)} ${r1(b)} ${r1(bx + thick)} ${r1(b - rr)} V ${r1(t)} Z`}" fill="${fill}"/>`
        : `<rect x="${r1(bx)}" y="${r1(t)}" width="${r1(thick)}" height="${r1(h)}" fill="${fill}"/>`); };
    for (let k = 0; k < n; k++) {
      const gx = left + band * k + (band - group) / 2;
      if (s.stacked) {
        let pos = 0, neg = 0; const last = s.series.map((q) => q.values[k] || 0).reduce((L, v, j) => (v ? j : L), -1);
        for (const [j, q] of s.series.entries()) { const v = q.values[k] || 0; if (!v) continue; const a = v > 0 ? pos : neg, b = a + v; v > 0 ? (pos = b) : (neg = b);
          const gap = j < last ? 2 : 0, ya = Y(a), yb = Y(b) + (v > 0 ? gap : -gap); bar(gx, ya, yb, SERIES[j], j === last); }
      } else for (const [j, q] of s.series.entries()) { const v = q.values[k] ?? 0; bar(gx + j * (thick + 2), Y(Math.max(y0, Math.min(0, y1))), Y(v), SERIES[j], true); }
    }
    if (s.series.length === 1 && !s.stacked && n <= 16) // single series: the value at each bar's tip
      for (let k = 0; k < n; k++) { const v = s.series[0].values[k] ?? 0, cx = left + band * (k + 0.5); out.push(`<text x="${r1(cx)}" y="${r1(v >= 0 ? Y(v) - 6 : Y(v) + 15)}" font-size="12" fill="${C.ink2}" text-anchor="middle">${x(fmt(v))}</text>`); }
    return wrap(out, W, H, s);
  }
  // line
  const X = (k) => left + band * (k + 0.5);
  for (const [j, q] of s.series.entries()) {
    const pts = q.values.map((v, k) => `${r1(X(k))} ${r1(Y(v))}`);
    out.push(`<path d="M ${pts.join(" L ")}" fill="none" stroke="${SERIES[j]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    if (q.values.length <= 40) for (const [k, v] of q.values.entries()) if (k === q.values.length - 1 || q.values.length <= 12) out.push(`<circle cx="${r1(X(k))}" cy="${r1(Y(v))}" r="4" fill="${SERIES[j]}" stroke="${C.surface}" stroke-width="2"/>`);
  }
  if (s.series.length === 1) { const q = s.series[0], k = q.values.length - 1; out.push(`<text x="${r1(Math.min(X(k), right - 8))}" y="${r1(Y(q.values[k]) - 10)}" font-size="12" fill="${C.ink2}" text-anchor="middle">${x(fmt(q.values[k]))}</text>`); }
  return wrap(out, W, H, s);
}
function wrap(parts, W, H, s) {
  const desc = s.type === "pie" ? s.labels.map((l, k) => `${l}: ${s.series[0].values[k]}`).join("; ") : s.series.map((q) => q.name).join(", ");
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT}' role="img" aria-label="${x((s.title || s.type + " chart") + ". " + desc).slice(0, 600)}">\n<rect width="${W}" height="${H}" fill="${C.surface}"/>\n${parts.join("\n")}\n</svg>\n`, width: W, height: H, spec: s };
}

// rows from a CSV or TSV file: the first column gives the labels, the other columns (or the chosen ones) the series
export function seriesFromCsv(text, columns) {
  const sep = (text.split(/\r?\n/)[0].match(/\t/g) || []).length > (text.split(/\r?\n/)[0].match(/,/g) || []).length ? "\t" : (text.split(/\r?\n/)[0].match(/;/g) || []).length > (text.split(/\r?\n/)[0].match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  for (const line of text.split(/\r?\n/)) { if (!line.trim()) continue; const cells = []; let cur = "", q = false;
    for (let k = 0; k < line.length; k++) { const c = line[k]; if (q) { if (c === '"' && line[k + 1] === '"') { cur += '"'; k++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === sep) { cells.push(cur); cur = ""; } else cur += c; }
    cells.push(cur); rows.push(cells.map((c) => c.trim())); if (rows.length > 501) break; }
  if (rows.length < 2) throw new Error("the file needs a header row and at least one data row");
  const head = rows[0], want = Array.isArray(columns) && columns.length ? columns.map(String) : head.slice(1);
  const idx = want.map((c) => { const k = head.findIndex((h) => h.toLowerCase() === c.toLowerCase()); if (k < 1) throw new Error(`column "${c}" is not in the file (columns: ${head.join(", ")})`); return k; });
  return { labels: rows.slice(1).map((r) => r[0] ?? ""), series: idx.map((k) => ({ name: head[k], values: rows.slice(1).map((r) => num(r[k])) })) };
}
