/* SafeShare UI — AGPL-3.0-or-later */
import { analyzePdf } from '../engine/pdf-analyzer.js';
import { analyzeImage, cleanImage } from '../engine/exif.js';
import { stripPdfMetadata } from '../engine/pdf-fixer.js';

const MAX_BYTES = 200 * 1024 * 1024;

const $ = id => document.getElementById(id);
const drop = $('drop'), fileInput = $('file');

let pdfjsLib = null, PDFLib = null;
async function libs() {
  pdfjsLib ??= await import('../../vendor/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc ||= new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).href;
  PDFLib ??= await import('../../vendor/pdf-lib.esm.min.js');
  return { pdfjsLib, PDFLib };
}

// A deliberately leaky one-page PDF (same file as test/corpus/fake-redaction.pdf):
// an account number drawn as text, then covered with a black rectangle.
const SAMPLE_B64 = 'JVBERi0xLjcKJYGBgYEKCjYgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAyODEKPj4Kc3RyZWFtCnicfVHLSkMxEN3nK7IWxMlkHgmIi/amuHAj3J24kNr6oF1URH/fk6qXUqkMmcyZzCQnc3ZhNgaK3d6ewsX1avOxen9ZPpw71SKFvNSYOI7rwBLHm5D2pSkqRSeK4zZcajZ1cbG5qQ1YzYXJkrkz0EGuOpPjxBnVFV0ZdXOrnoHVelfvmNsCre0qjq9hPAttDLdhd4pnxcVWWK2c4mn6zVOSZNhCVZrirQ5yys5DrjDOiUlJqjScFZhkZkK9SxNVxMq4Y4Y4SwGCl4TcIOmI60SU4me4u0f8ODESjSY5LrdTpvu/sG/d4z+bkMtBQNifw/q/qTARFdJa7ORUftWzPn+owV0/KJD38++ZZpNeP2omoHKkzBdsvnppCmVuZHN0cmVhbQplbmRvYmoKCjcgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL09ialN0bQovTiA1Ci9GaXJzdCAyNgovTGVuZ3RoIDM4Mgo+PgpzdHJlYW0KeJzVUk1LAzEQvedXzFEPko/u5kNKobZdBSmWVlAUD+tuKCuSyG4q+u+d2a0WEfEsYUhm3ptkJvMkCFCQZTACYyGDfKQgB6MNjMeMX7+/eOCrcus7xi+buoN75AhYwwPjs7gLCSSbTNiBOytT+Ry3bEgCSeRPxqqN9a7yLYyLRVEIYYQQOkPTQqg57jM0h6bQR0xZPKOZbG8YMyMhRlPEisG0GXII77n5Pn+BO3I1ceYDN7OD//UuvbUY7lB/1eMmjC9jPS+Th6P5qRJKC6ucdDKT8u4Yv6P1ZYr/t7m+/iaGXzv8NmcaLw259aSBfsp87bu4ayscO/GKiAgdLvzzq09NVZ4Y4SzWaaxDjfUpB8yZTGmrcm1/YvRfVuTO6j2GpfDbq8cnX/VPkLt4S+ebRLUPAYotfd2UZ/ENVStwaanAOEXanYYQE6m513FI2AV5eq/tb61SI4xvdo+pdykoGT8rO9+3eKgTiwhVrJuwBX7ThGnoms8A3fgB8l7USgplbmRzdHJlYW0KZW5kb2JqCgo4IDAgb2JqCjw8Ci9TaXplIDkKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL1hSZWYKL0xlbmd0aCA0MQovVyBbIDEgMiAyIF0KL0luZGV4IFsgMCA5IF0KPj4Kc3RyZWFtCnicFcTBDQAwCAOxCyD12+kYpPtLlPhhYCY44OTCpStxQXpbNnxeQQMVCmVuZHN0cmVhbQplbmRvYmoKCnN0YXJ0eHJlZgo4NTQKJSVFT0Y=';

document.getElementById('sample').addEventListener('click', () => {
  const bytes = Uint8Array.from(atob(SAMPLE_B64), c => c.charCodeAt(0));
  handle(new File([bytes], 'sample-leaky.pdf', { type: 'application/pdf' }));
});

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => fileInput.files[0] && handle(fileInput.files[0]));
['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hover'); }));
drop.addEventListener('drop', e => e.dataTransfer.files[0] && handle(e.dataTransfer.files[0]));

let running = false;

async function handle(file) {
  if (running) return;
  running = true;
  reset();
  try {
    if (file.size > MAX_BYTES) {
      throw new Error('files over 200 MB are not supported yet');
    }
    setFileLine(file);
    status('reading file locally — nothing is uploaded');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isPdf = (bytes[0] === 0x25 && bytes[1] === 0x50) // %P
      || file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (isPdf) await handlePdf(file, bytes);
    else await handleImage(file, bytes);
  } catch (err) {
    const hint = /password|encrypt/i.test(String(err))
      ? ' If the file is password-protected, remove the password and try again.'
      : '';
    status(`could not analyze this file: ${err.message}.${hint}`);
  } finally {
    running = false;
  }
}

async function handlePdf(file, bytes) {
  const { pdfjsLib } = await libs();
  const { findings, summary } = await analyzePdf(
    bytes, pdfjsLib,
    (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
    { standardFontDataUrl: new URL('../../vendor/standard_fonts/', import.meta.url).href },
    (page, total) => status(`checking page ${page} of ${total}…`),
  );
  $('filemeta').textContent += ` · ${summary.pages} page${summary.pages === 1 ? '' : 's'}`;
  render(file.name, findings, summary.checked);
  if (findings.some(f => f.id === 'info-dict' || f.id === 'xmp')) {
    addAction('Strip metadata, download clean copy', async () => {
      const { PDFLib } = await libs();
      const clean = await stripPdfMetadata(await file.arrayBuffer(), PDFLib);
      download(clean, file.name.replace(/\.pdf$/i, '') + '.clean.pdf', 'application/pdf');
    });
  }
  if (findings.some(f => f.id === 'fake-redaction' || f.id === 'unapplied-redact')) {
    addAction('Why stripping is not enough here', () =>
      window.open('https://github.com/karanmonu/safeshare#what-it-fixes', '_blank', 'noopener'), true);
  }
}

async function handleImage(file, bytes) {
  const { findings, summary } = analyzeImage(bytes);
  if (summary.unsupported) {
    status('unsupported image format — jpeg and png only for now (heic/webp are on the roadmap)');
    return;
  }
  render(file.name, findings,
    ['EXIF identity fields', 'GPS coordinates', 'IPTC/Photoshop blocks', 'XMP packets', 'PNG text/eXIf/tIME chunks']);
  if (findings.length) {
    addAction('Strip metadata, download clean copy', () => {
      const clean = cleanImage(bytes);
      const ext = summary.format === 'png' ? 'png' : 'jpg';
      download(clean, file.name.replace(/\.[^.]+$/, '') + `.clean.${ext}`, `image/${summary.format}`);
    });
  }
}

/* ---------- rendering ---------- */

function reset() {
  status('');
  $('fileline').classList.remove('show');
  $('verdict').innerHTML = ''; $('results').innerHTML = '';
  $('actions').innerHTML = ''; $('checked').textContent = '';
}

function status(msg) { $('status').textContent = msg; }

function setFileLine(file) {
  $('filename').textContent = file.name;
  $('filemeta').textContent = humanSize(file.size);
  $('fileline').classList.add('show');
}

function render(name, findings, checked) {
  status('');
  const critical = findings.filter(f => f.severity === 'critical').length;
  const v = $('verdict');
  if (critical) {
    v.innerHTML = `<div class="verdict bad"><span class="stamp">Leaks data</span>
      <div>${critical} critical finding${critical === 1 ? '' : 's'}. Do not send this file as-is.</div>
      <p>Everything below is recoverable by anyone who receives the file.</p></div>`;
  } else if (findings.length) {
    v.innerHTML = `<div class="verdict warn"><span class="stamp">Review first</span>
      <div>No hidden content found, but the file carries metadata about you.</div></div>`;
  } else {
    v.innerHTML = `<div class="verdict ok"><span class="stamp">No known leak patterns</span>
      <div>None of the checks below found anything recoverable.</div></div>`;
  }
  const order = { critical: 0, warning: 1, info: 2 };
  $('results').innerHTML = findings
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map(f => `
      <section class="finding ${f.severity}">
        <span class="sev">${f.severity}</span>
        <h3>${escapeHtml(f.title)}</h3>
        <div class="detail">${escapeHtml(f.detail)}</div>
        ${f.recovered ? `
          <div class="recovered">
            <button type="button">Show the text an attacker recovers</button>
            <pre>${escapeHtml(f.recovered)}</pre>
          </div>` : ''}
      </section>`).join('');
  $('results').querySelectorAll('.recovered > button').forEach(button =>
    button.addEventListener('click', () => button.parentElement.classList.toggle('open')));
  $('checked').textContent = 'checks run — ' + checked.join(' · ');
}

function addAction(label, fn, secondary = false) {
  const b = document.createElement('button');
  b.textContent = label;
  if (secondary) b.className = 'secondary';
  b.addEventListener('click', fn);
  $('actions').appendChild(b);
}

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
