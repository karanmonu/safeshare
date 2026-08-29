/**
 * SafeShare PDF analyzer — pure detection, no mutation.
 *
 * Core method ("pixel truth vs text truth"): render the page exactly as a
 * human sees it, then compare against what a machine can extract. Any text
 * that is machine-extractable but sits on near-uniform dark pixels is a
 * fake redaction — regardless of HOW the box was drawn (vector rect,
 * highlight annotation, or burned into a scanned image over an OCR layer).
 *
 * Works in browser and Node: caller injects pdfjsLib and a canvas factory.
 * AGPL-3.0-or-later.
 */

const DARK_LUMA = 64;        // mean luminance below this = "dark cover"
const UNIFORM_STDDEV = 18;   // low variance = solid box, not a photo
const RENDER_SCALE = 1.5;

/** @typedef {{ id:string, severity:'critical'|'warning'|'info', title:string,
 *   detail:string, page?:number, recovered?:string }} Finding */

export async function analyzePdf(data, pdfjsLib, createCanvas, loadOpts = {}, onPage = null) {
  const doc = await pdfjsLib.getDocument({ data, ...loadOpts }).promise;
  /** @type {Finding[]} */
  const findings = [];

  findings.push(...await metadataFindings(doc));
  findings.push(...await attachmentFindings(doc));

  for (let p = 1; p <= doc.numPages; p++) {
    onPage?.(p, doc.numPages);
    const page = await doc.getPage(p);
    findings.push(...await fakeRedactionFindings(page, p, pdfjsLib, createCanvas));
    findings.push(...await annotationFindings(page, p));
  }

  const summary = {
    critical: findings.filter(f => f.severity === 'critical').length,
    warning: findings.filter(f => f.severity === 'warning').length,
    info: findings.filter(f => f.severity === 'info').length,
    pages: doc.numPages,
    checked: [
      'text recoverable under dark covers (vector, annotation, or OCR-layer)',
      'unapplied redaction annotations',
      'document information dictionary',
      'XMP metadata and revision history',
      'embedded file attachments',
    ],
  };
  await doc.destroy();
  return { findings, summary };
}

/* ---------- fake redactions: pixel truth vs text truth ---------- */

async function fakeRedactionFindings(page, pageNum, pdfjsLib, createCanvas) {
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const w = Math.ceil(viewport.width), h = Math.ceil(viewport.height);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  // annotationMode DISABLE would hide covers drawn as annotations; keep ENABLE
  // so annotation covers are part of the pixel truth.
  await page.render({ canvasContext: ctx, viewport }).promise;
  const img = ctx.getImageData(0, 0, w, h);

  const textContent = await page.getTextContent();
  const hits = [];
  for (const item of textContent.items) {
    const str = (item.str || '').trim();
    if (!str) continue;
    // Text-space -> device-space transform for this item.
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontH = Math.hypot(tx[2], tx[3]);
    const width = (item.width || 0) * RENDER_SCALE;
    if (fontH < 2 || width < 2) continue;
    // Baseline at (tx[4], tx[5]); glyph box sits above the baseline.
    const box = clampBox(tx[4], tx[5] - fontH, width, fontH, w, h);
    if (!box) continue;
    const stats = lumaStats(img, box);
    if (stats.mean < DARK_LUMA && stats.stddev < UNIFORM_STDDEV) {
      hits.push({ str, box });
    }
  }
  if (!hits.length) return [];
  const recovered = hits.map(hit => hit.str).join(' ');
  return [{
    id: 'fake-redaction',
    severity: 'critical',
    page: pageNum,
    title: `Page ${pageNum}: text is recoverable under ${hits.length} dark cover(s)`,
    detail: 'The black boxes on this page only hide text visually. Copy-paste, '
      + 'text extraction, or any AI assistant will read it. This is the exact '
      + 'failure mode of the 2025 DOJ Epstein files release.',
    recovered,
  }];
}

function clampBox(x, y, width, height, maxW, maxH) {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(maxW, Math.ceil(x + width)), y1 = Math.min(maxH, Math.ceil(y + height));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x0, y0, x1, y1 };
}

function lumaStats(img, { x0, y0, x1, y1 }) {
  // Sample a grid (max ~400 px) instead of every pixel: fast on big pages.
  const stepX = Math.max(1, Math.floor((x1 - x0) / 20));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 20));
  let sum = 0, sumSq = 0, n = 0;
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * img.width + x) * 4;
      const luma = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      sum += luma; sumSq += luma * luma; n++;
    }
  }
  if (!n) return { mean: 255, stddev: 0 };
  const mean = sum / n;
  return { mean, stddev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

/* ---------- unapplied redaction + cover annotations ---------- */

async function annotationFindings(page, pageNum) {
  const findings = [];
  const annots = await page.getAnnotations();
  const redacts = annots.filter(a => a.subtype === 'Redact');
  if (redacts.length) {
    findings.push({
      id: 'unapplied-redact',
      severity: 'critical',
      page: pageNum,
      title: `Page ${pageNum}: ${redacts.length} redaction annotation(s) were never applied`,
      detail: 'A /Redact annotation marks content for removal but does not remove it. '
        + 'The content underneath is fully intact until the redaction is applied.',
    });
  }
  const covers = annots.filter(a =>
    (a.subtype === 'Square' || a.subtype === 'Highlight') && isDarkColor(a.color));
  if (covers.length) {
    findings.push({
      id: 'cover-annotation',
      severity: 'warning',
      page: pageNum,
      title: `Page ${pageNum}: ${covers.length} dark shape annotation(s) drawn over the page`,
      detail: 'Dark Square/Highlight annotations are a common way to "redact". '
        + 'Annotations sit on a separate layer and can be deleted by any PDF '
        + 'viewer, revealing whatever is underneath.',
    });
  }
  return findings;
}

function isDarkColor(color) {
  if (!color) return true; // no color entry commonly renders black
  const vals = Array.from(color);
  return vals.length >= 3 && (0.299 * vals[0] + 0.587 * vals[1] + 0.114 * vals[2]) < DARK_LUMA;
}

/* ---------- metadata ---------- */

const INFO_FIELDS = ['Author', 'Creator', 'Producer', 'Title', 'Subject', 'Keywords',
  'CreationDate', 'ModDate'];

async function metadataFindings(doc) {
  const findings = [];
  const { info, metadata } = await doc.getMetadata().catch(() => ({}));
  const present = INFO_FIELDS.filter(f => info && String(info[f] || '').trim());
  if (present.length) {
    const values = present.map(f => `${f}: ${truncate(String(info[f]), 80)}`).join('\n');
    findings.push({
      id: 'info-dict',
      severity: 'warning',
      title: `Document information reveals ${present.length} field(s)`,
      detail: 'The info dictionary travels with the file and commonly leaks the '
        + 'author’s name, employer software, and editing timeline.\n' + values,
    });
  }
  if (metadata) {
    const raw = typeof metadata.getRaw === 'function' ? metadata.getRaw() : '';
    const hasHistory = /xmpMM:History|stEvt:/.test(raw);
    findings.push({
      id: 'xmp',
      severity: hasHistory ? 'warning' : 'info',
      title: hasHistory ? 'XMP metadata includes revision history' : 'XMP metadata present',
      detail: hasHistory
        ? 'xmpMM:History records prior save events (tools, timestamps, document IDs) '
          + 'across the file’s life — including before any redaction was made.'
        : 'Embedded XMP packet present. It can carry author, tool, and document '
          + 'identifiers even when the info dictionary is clean.',
    });
  }
  return findings;
}

async function attachmentFindings(doc) {
  const attachments = await doc.getAttachments().catch(() => null);
  if (!attachments) return [];
  const names = Object.keys(attachments);
  if (!names.length) return [];
  return [{
    id: 'attachments',
    severity: 'critical',
    title: `${names.length} embedded file(s) travel inside this PDF`,
    detail: 'Embedded attachments are full files hidden inside the document: '
      + names.map(name => truncate(name, 60)).join(', ')
      + '. Recipients can extract them even if no page displays them.',
  }];
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
