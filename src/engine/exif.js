/**
 * SafeShare image analyzer + cleaner — JPEG EXIF and PNG text chunks.
 * Pure JS, zero dependencies, lossless stripping (no re-encode).
 * AGPL-3.0-or-later.
 */

const TAGS = {
  0x010f: 'Camera make', 0x0110: 'Camera model', 0x0131: 'Software',
  0x0132: 'Date/time', 0x013b: 'Artist', 0x8298: 'Copyright',
  0x9003: 'Original date/time', 0xa430: 'Camera owner', 0xa431: 'Body serial number',
};
const GPS_IFD = 0x8825, EXIF_IFD = 0x8769;

export function analyzeImage(bytes) {
  if (isJpeg(bytes)) return analyzeJpeg(bytes);
  if (isPng(bytes)) return analyzePng(bytes);
  return { findings: [], summary: { unsupported: true } };
}

export function cleanImage(bytes) {
  if (isJpeg(bytes)) return stripJpeg(bytes);
  if (isPng(bytes)) return stripPng(bytes);
  return bytes;
}

const isJpeg = b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
const isPng = b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50;

/* ---------------- JPEG ---------------- */

function* jpegSegments(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1];
    if (marker === 0xda) break; // start of scan — entropy data follows
    const len = (b[i + 2] << 8) | b[i + 3];
    yield { marker, start: i, end: i + 2 + len };
    i += 2 + len;
  }
}

function analyzeJpeg(bytes) {
  const findings = [];
  for (const seg of jpegSegments(bytes)) {
    if (seg.marker === 0xe1 && ascii(bytes, seg.start + 4, 4) === 'Exif') {
      findings.push(...exifFindings(bytes.subarray(seg.start + 10, seg.end)));
    } else if (seg.marker === 0xed) {
      findings.push({
        id: 'iptc', severity: 'warning', title: 'IPTC/Photoshop metadata present',
        detail: 'APP13 segments carry captions, keywords, and editing metadata.',
      });
    } else if (seg.marker === 0xe1 && ascii(bytes, seg.start + 4, 5) === 'http:') {
      findings.push({
        id: 'xmp-image', severity: 'warning', title: 'XMP metadata present',
        detail: 'XMP can carry author, location, and full edit history.',
      });
    }
  }
  return { findings, summary: { format: 'jpeg' } };
}

function exifFindings(tiff) {
  const findings = [];
  const le = ascii(tiff, 0, 2) === 'II';
  const u16 = off => le ? tiff[off] | (tiff[off + 1] << 8) : (tiff[off] << 8) | tiff[off + 1];
  const u32 = off => le
    ? (tiff[off] | (tiff[off + 1] << 8) | (tiff[off + 2] << 16) | (tiff[off + 3] << 24)) >>> 0
    : ((tiff[off] << 24) | (tiff[off + 1] << 16) | (tiff[off + 2] << 8) | tiff[off + 3]) >>> 0;

  const walk = (ifdOff, out) => {
    if (ifdOff + 2 > tiff.length) return;
    const count = u16(ifdOff);
    for (let i = 0; i < count; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 12 > tiff.length) return;
      const tag = u16(e), type = u16(e + 2), n = u32(e + 4);
      if (tag === GPS_IFD) out.gps = true;
      else if (tag === EXIF_IFD) walk(u32(e + 8), out);
      else if (TAGS[tag] && type === 2 && n > 1) {
        const valOff = n <= 4 ? e + 8 : u32(e + 8);
        out.fields.push(`${TAGS[tag]}: ${ascii(tiff, valOff, Math.min(n - 1, 60))}`);
      }
    }
  };
  const out = { gps: false, fields: [] };
  walk(u32(4), out);

  if (out.gps) findings.push({
    id: 'gps', severity: 'critical', title: 'GPS location embedded in this photo',
    detail: 'Anyone who receives this file can read the exact coordinates of '
      + 'where it was taken — commonly someone’s home.',
  });
  if (out.fields.length) findings.push({
    id: 'exif', severity: 'warning',
    title: `EXIF reveals ${out.fields.length} identifying field(s)`,
    detail: out.fields.join('\n'),
  });
  return findings;
}

function stripJpeg(bytes) {
  // Keep only segments a decoder needs; drop APPn>0 and COM. Lossless.
  // Orientation is the one EXIF value a photo needs to display correctly,
  // so it is re-inserted alone — stripping it would silently rotate photos.
  const orientation = readOrientation(bytes);
  const keep = [bytes.subarray(0, 2)];
  if (orientation > 1) keep.push(orientationOnlyExif(orientation));
  let tail = 2;
  for (const seg of jpegSegments(bytes)) {
    tail = seg.end;
    const isMeta = (seg.marker >= 0xe1 && seg.marker <= 0xef) || seg.marker === 0xfe;
    if (!isMeta) keep.push(bytes.subarray(seg.start, seg.end));
  }
  keep.push(bytes.subarray(tail)); // scan data to EOF
  return concat(keep);
}

export function readOrientation(bytes) {
  if (!isJpeg(bytes)) return 1;
  for (const seg of jpegSegments(bytes)) {
    if (seg.marker !== 0xe1 || ascii(bytes, seg.start + 4, 4) !== 'Exif') continue;
    const tiff = bytes.subarray(seg.start + 10, seg.end);
    const le = ascii(tiff, 0, 2) === 'II';
    const u16 = off => le ? tiff[off] | (tiff[off + 1] << 8) : (tiff[off] << 8) | tiff[off + 1];
    const u32 = off => le
      ? (tiff[off] | (tiff[off + 1] << 8) | (tiff[off + 2] << 16) | (tiff[off + 3] << 24)) >>> 0
      : ((tiff[off] << 24) | (tiff[off + 1] << 16) | (tiff[off + 2] << 8) | tiff[off + 3]) >>> 0;
    const ifd = u32(4);
    if (ifd + 2 > tiff.length) return 1;
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > tiff.length) return 1;
      if (u16(e) === 0x0112) return u16(e + 8) || 1;
    }
  }
  return 1;
}

function orientationOnlyExif(orientation) {
  // APP1 { 'Exif\0\0', TIFF II*\0, IFD0: [Orientation=n], next=0 }
  const tiff = [
    0x49, 0x49, 42, 0, 8, 0, 0, 0,      // II, magic, IFD0 @8
    1, 0,                                // one entry
    0x12, 0x01, 3, 0, 1, 0, 0, 0,        // tag 0x0112, SHORT, count 1
    orientation & 0xff, 0, 0, 0,         // value
    0, 0, 0, 0,                          // next IFD
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // 'Exif\0\0'
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
}

/* ---------------- PNG ---------------- */

const PNG_META = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function* pngChunks(b) {
  let i = 8;
  while (i + 8 <= b.length) {
    const len = (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
    const type = ascii(b, i + 4, 4);
    yield { type, start: i, end: i + 12 + len };
    i += 12 + len;
    if (type === 'IEND') break;
  }
}

function analyzePng(bytes) {
  const found = [];
  for (const c of pngChunks(bytes)) if (PNG_META.has(c.type)) found.push(c.type);
  const findings = found.length ? [{
    id: 'png-meta', severity: found.includes('eXIf') ? 'critical' : 'warning',
    title: `PNG carries ${found.length} metadata chunk(s): ${[...new Set(found)].join(', ')}`,
    detail: 'PNG text/EXIF chunks can hold author names, software, timestamps, '
      + 'and (in eXIf) GPS coordinates.',
  }] : [];
  return { findings, summary: { format: 'png' } };
}

function stripPng(bytes) {
  const keep = [bytes.subarray(0, 8)];
  for (const c of pngChunks(bytes)) {
    if (!PNG_META.has(c.type)) keep.push(bytes.subarray(c.start, c.end));
  }
  return concat(keep);
}

/* ---------------- utils ---------------- */

function ascii(b, off, n) {
  let s = '';
  for (let i = off; i < off + n && i < b.length; i++) {
    s += b[i] >= 32 && b[i] < 127 ? String.fromCharCode(b[i]) : '';
  }
  return s;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
