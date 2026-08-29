/**
 * SafeShare engine tests — runs the exact browser engine against the
 * generated corpus in Node. Run: node test/make-corpus.mjs && node test/run-tests.mjs
 * AGPL-3.0-or-later.
 */
import { readFileSync } from 'node:fs';
import { createCanvas, Path2D, DOMMatrix, ImageData } from '@napi-rs/canvas';

// pdf.js renders through DOM canvas APIs; provide them before it loads.
globalThis.Path2D ??= Path2D;
globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;

const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { analyzePdf } = await import('../src/engine/pdf-analyzer.js');
const { analyzeImage, cleanImage, readOrientation } = await import('../src/engine/exif.js');
const { stripPdfMetadata } = await import('../src/engine/pdf-fixer.js');
const PDFLib = await import('pdf-lib');

const corpus = name => new Uint8Array(readFileSync(new URL(`./corpus/${name}`, import.meta.url)));
const pdf = bytes => analyzePdf(bytes, pdfjsLib, (w, h) => createCanvas(w, h), {
  standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname,
  disableFontFace: true,
});

let failures = 0;
function check(label, cond, extra = '') {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${label}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
}

/* fake redaction */
{
  const { findings } = await pdf(corpus('fake-redaction.pdf'));
  const hit = findings.find(f => f.id === 'fake-redaction');
  check('fake-redaction: detected', !!hit, JSON.stringify(findings.map(f => f.id)));
  check('fake-redaction: recovers the hidden account number',
    !!hit && /4417-9921/.test(hit.recovered), hit && hit.recovered);
  check('fake-redaction: does not flag visible text',
    !hit || !/closing paragraph/i.test(hit.recovered));
}

/* metadata */
{
  const { findings } = await pdf(corpus('metadata.pdf'));
  const info = findings.find(f => f.id === 'info-dict');
  check('metadata: info dictionary flagged', !!info);
  check('metadata: author email surfaced', !!info && /priya\.venkat/.test(info.detail));
}

/* attachment */
{
  const { findings } = await pdf(corpus('attachment.pdf'));
  const att = findings.find(f => f.id === 'attachments');
  check('attachment: embedded file flagged as critical',
    !!att && att.severity === 'critical' && /payroll-draft\.csv/.test(att.detail));
}

/* clean control — the false-positive guard */
{
  const { findings } = await pdf(corpus('clean.pdf'));
  const noisy = findings.filter(f => f.severity !== 'info');
  check('clean control: no critical/warning findings', noisy.length === 0,
    JSON.stringify(noisy.map(f => f.id)));
}

/* fixer round-trip */
{
  const cleaned = await stripPdfMetadata(corpus('metadata.pdf'), PDFLib);
  const { findings } = await pdf(new Uint8Array(cleaned));
  check('fixer: stripped PDF passes its own audit',
    !findings.some(f => f.id === 'info-dict' || (f.id === 'xmp' && f.severity !== 'info')),
    JSON.stringify(findings.map(f => f.id)));
}

/* unapplied /Redact annotation */
{
  const { findings } = await pdf(corpus('unapplied-redact.pdf'));
  check('unapplied-redact: flagged critical',
    findings.some(f => f.id === 'unapplied-redact' && f.severity === 'critical'),
    JSON.stringify(findings.map(f => f.id)));
}

/* false-positive guard: visible white text on a dark banner */
{
  const { findings } = await pdf(corpus('white-on-dark.pdf'));
  check('white-on-dark: visible light text NOT reported as hidden',
    !findings.some(f => f.id === 'fake-redaction'),
    JSON.stringify(findings.map(f => f.id)));
}

/* image: GPS detection + lossless strip round-trip */
{
  const photo = corpus('gps-photo.jpg');
  const { findings } = analyzeImage(photo);
  check('image: GPS flagged critical', findings.some(f => f.id === 'gps' && f.severity === 'critical'));
  check('image: camera make surfaced', findings.some(f => /LeakCam/.test(f.detail || '')));
  const cleaned = cleanImage(photo);
  const { findings: after } = analyzeImage(cleaned);
  check('image: cleaned copy passes its own audit', after.length === 0,
    JSON.stringify(after.map(f => f.id)));
  check('image: cleaning preserves display orientation', readOrientation(cleaned) === 6,
    `orientation=${readOrientation(cleaned)}`);
}

console.log(failures ? `\n${failures} test(s) FAILED` : '\nall tests passed');
process.exit(failures ? 1 : 0);
