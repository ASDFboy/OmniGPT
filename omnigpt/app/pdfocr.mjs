// Built with Claude (Anthropic) - see CREDITS.md
// ocr (the OCR engine built into Windows, offline) and pdf_tools (merge, split, rotate, extract pages with qpdf, a
// free program installed on demand with install_tool winget QPDF.QPDF). Paths are already checked by tools.mjs.
import fs from "node:fs";
import path from "node:path";

// ---------- OCR: Windows.Media.Ocr through PowerShell. PDFs are drawn page by page with Windows.Data.Pdf first.
export const OCR_PS = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
$null=[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$x=[System.WindowsRuntimeSystemExtensions]
$opT=($x.GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'})[0]
$actT=($x.GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'})[0]
function Op($o,[Type]$t){$k=$opT.MakeGenericMethod($t).Invoke($null,@($o));$k.Wait(-1)|Out-Null;$k.Result}
function Act($a){$k=$actT.Invoke($null,@($a));$k.Wait(-1)|Out-Null}
$E=[Windows.Media.Ocr.OcrEngine]
if($env:ORC_LANG){ $L=New-Object Windows.Globalization.Language $env:ORC_LANG
  if(-not $E::IsLanguageSupported($L)){ Write-Output ("NOLANG|"+(($E::AvailableRecognizerLanguages|%{$_.LanguageTag}) -join ', ')); exit 5 }
  $eng=$E::TryCreateFromLanguage($L) } else { $eng=$E::TryCreateFromUserProfileLanguages() }
if(-not $eng -and $E::AvailableRecognizerLanguages.Count){ $eng=$E::TryCreateFromLanguage($E::AvailableRecognizerLanguages[0]) }
if(-not $eng){ Write-Output "NOENGINE"; exit 4 }
Write-Output ("LANG|"+$eng.RecognizerLanguage.LanguageTag)
$max=$E::MaxImageDimension
function Rec($stream){
  $dec=Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $w=$dec.PixelWidth; $h=$dec.PixelHeight; $s=[Math]::Min(1.0, $max/[Math]::Max($w,$h))
  $t=New-Object Windows.Graphics.Imaging.BitmapTransform; if($s -lt 1){ $t.ScaledWidth=[uint32]($w*$s); $t.ScaledHeight=[uint32]($h*$s) }
  $bmp=Op ($dec.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,$t,[Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,[Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $r=Op ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  ($r.Lines|%{$_.Text}) -join "\`n"
}
$file=Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:ORC_P)) ([Windows.Storage.StorageFile])
if($env:ORC_P -match '\\.pdf$'){
  $doc=Op ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  Write-Output ("PAGES|"+$doc.PageCount)
  $list=if($env:ORC_PAGES -eq 'all'){1..[Math]::Min([int]$doc.PageCount,30)}else{$env:ORC_PAGES -split ','}
  foreach($n in $list){ $i=[int]$n-1; if($i -lt 0 -or $i -ge $doc.PageCount){continue}
    $pg=$doc.GetPage([uint32]$i); $ms=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $o=New-Object Windows.Data.Pdf.PdfPageRenderOptions; $o.DestinationWidth=[uint32][Math]::Min(2400,[Math]::Max(1400,$pg.Size.Width*2.5))
    Act ($pg.RenderToStreamAsync($ms,$o)); Write-Output ("PAGE|"+($i+1)); Write-Output (Rec $ms); $pg.Dispose() }
} else {
  $st=Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  Write-Output "PAGE|0"; Write-Output (Rec $st)
}`;
export const OCR_EXT = /\.(png|jpe?g|jfif|bmp|gif|tiff?|ico|heic|webp|pdf)$/i;
// "1-3,7" -> [1,2,3,7] (at most 50 pages)
export function pageList(spec) {
  if (spec === undefined || spec === null || spec === "" || spec === "all") return "all";
  const out = [];
  for (const part of String(spec).replace(/\s+/g, "").split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part); if (!m) throw new Error(`pages must look like 1-3,5 (got "${spec}")`);
    const a = +m[1], b = m[2] ? +m[2] : a; if (a < 1 || b < a) throw new Error(`bad page range "${part}"`);
    for (let k = a; k <= b && out.length < 50; k++) out.push(k);
  }
  return out;
}
export function parseOcr(out) {
  if (/^NOENGINE/m.test(out)) throw new Error("Windows has no OCR language installed. Add one in Settings > Time & language > Language & region (a language with \"Optical character recognition\"), then try again.");
  const nl = /^NOLANG\|(.*)$/m.exec(out); if (nl) throw new Error("that OCR language is not installed. Installed: " + (nl[1].trim() || "none"));
  const lang = (/^LANG\|(.*)$/m.exec(out) || [])[1] || "", pages = Number((/^PAGES\|(\d+)/m.exec(out) || [])[1]) || 0, parts = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    const m = /^PAGE\|(\d+)$/.exec(line.trim());
    if (m) { cur = { page: +m[1], lines: [] }; parts.push(cur); continue; }
    if (cur && !/^(LANG|PAGES)\|/.test(line)) cur.lines.push(line);
  }
  if (!parts.length) throw new Error("the OCR engine gave no result: " + out.trim().slice(-300));
  return { lang: lang.trim(), pages, parts: parts.map((p) => ({ page: p.page, text: p.lines.join("\n").trim() })) };
}

// ---------- PDF tools: qpdf, run directly (no shell) with checked, absolute paths
export const PDF_ACTIONS = new Set(["info", "merge", "split", "rotate", "extract"]);
export const qpdfRange = (spec) => { const s = String(spec ?? "").replace(/\s+/g, ""); if (!/^(z|r?\d+)(-(z|r?\d+))?(,(z|r?\d+)(-(z|r?\d+))?)*$/i.test(s)) throw new Error(`pages must look like 1-3,7 or 5-z (z = last page; got "${spec}")`); return s.toLowerCase(); };
export const stem = (p) => path.join(path.dirname(p), path.basename(p, path.extname(p)));
export function qpdfFailed(r) { // 0 = fine, 3 = fine with warnings
  if (r.code === 0 || r.code === 3) return null;
  const t = r.out.trim();
  if (/password|encrypt/i.test(t)) return "the PDF is password-protected; it cannot be changed without the password";
  return (t || "qpdf failed with code " + r.code).slice(-400);
}
export const newFiles = (dir, before) => { try { return fs.readdirSync(dir).filter((f) => !before.has(f)).sort().map((f) => path.join(dir, f)); } catch { return []; } };
