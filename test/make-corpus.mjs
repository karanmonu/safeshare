/**
 * Generates the SafeShare test corpus: deliberately leaky documents with
 * known ground truth. Run: node test/make-corpus.mjs
 * AGPL-3.0-or-later.
 */
import { PDFDocument, StandardFonts, rgb, PDFName } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync(new URL('./corpus/', import.meta.url), { recursive: true });
const out = (name, bytes) => writeFileSync(new URL(`./corpus/${name}`, import.meta.url), bytes);

const SECRET = 'ACCOUNT 4417-9921 PIN 8842 OWNER RAKESH SHARMA';

/* 1. Fake redaction: secret text with a black rectangle painted over it. */
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Settlement agreement — parties listed below.', { x: 50, y: 700, size: 12, font });
  page.drawText(SECRET, { x: 50, y: 650, size: 12, font });
  page.drawRectangle({ x: 45, y: 643, width: 380, height: 24, color: rgb(0, 0, 0) });
  page.drawText('Visible closing paragraph.', { x: 50, y: 600, size: 12, font });
  out('fake-redaction.pdf', await doc.save());
}

/* 2. Metadata-laden: info dict fully populated. */
{
  const doc = await PDFDocument.create();
  doc.setTitle('Internal — do not distribute');
  doc.setAuthor('priya.venkat@examplecorp.com');
  doc.setCreator('ExampleCorp Legal Wing');
  doc.setProducer('Acrobat Pro 24.1');
  doc.setSubject('M&A draft 7');
  doc.setKeywords(['confidential', 'project-krypton']);
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('A completely innocuous page.', { x: 50, y: 700, size: 12, font });
  out('metadata.pdf', await doc.save());
}

/* 3. Embedded attachment hiding inside the PDF. */
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Nothing to see on this page.', { x: 50, y: 700, size: 12, font });
  await doc.attach(new TextEncoder().encode('salary,bonus\n0xCAFE,0xBABE'),
    'payroll-draft.csv', { mimeType: 'text/csv' });
  out('attachment.pdf', await doc.save());
}

/* 4. Clean control: no known leaks. */
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Clean control document.', { x: 50, y: 700, size: 12, font });
  const bytes = await doc.save();
  const clean = await PDFDocument.load(bytes, { updateMetadata: false });
  const infoRef = clean.context.trailerInfo.Info;
  if (infoRef) {
    const info = clean.context.lookup(infoRef);
    for (const key of [...info.keys()]) info.delete(key);
    delete clean.context.trailerInfo.Info;
  }
  clean.catalog.delete(PDFName.of('Metadata'));
  out('clean.pdf', await clean.save());
}

/* 5. Unapplied /Redact annotation: marked for removal, removed nothing. */
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(SECRET, { x: 50, y: 650, size: 12, font });
  const annot = doc.context.obj({
    Type: 'Annot', Subtype: 'Redact',
    Rect: [45, 643, 430, 670],
    QuadPoints: [45, 670, 430, 670, 45, 643, 430, 643],
    IC: [0, 0, 0], F: 4,
  });
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
  out('unapplied-redact.pdf', await doc.save());
}

/* 6. False-positive guard: VISIBLE white text on a dark banner (title-slide
   design). Must NOT be reported — the text is not hidden. */
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawRectangle({ x: 0, y: 640, width: 612, height: 80, color: rgb(0.05, 0.05, 0.08) });
  page.drawText('QUARTERLY REVIEW — PUBLIC EDITION', {
    x: 60, y: 672, size: 20, font, color: rgb(1, 1, 1),
  });
  out('white-on-dark.pdf', await doc.save());
}

/* 7. JPEG with GPS EXIF (hand-built segments; parser-level ground truth). */
{
  const tiff = buildTiffWithGps();
  const app1 = [0xff, 0xe1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // 'Exif\0\0'
  const len = app1.length - 2;
  app1[2] = len >> 8; app1[3] = len & 0xff;
  out('gps-photo.jpg', Uint8Array.from([0xff, 0xd8, ...app1, 0xff, 0xd9]));
}

function buildTiffWithGps() {
  // Little-endian TIFF: IFD0 { Make:"LeakCam", Orientation:6, GPSIFD -> stub }
  const b = [];
  const u16 = v => b.push(v & 0xff, v >> 8);
  const u32 = v => b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  b.push(0x49, 0x49); u16(42); u32(8);            // II, magic, IFD0 @8
  u16(3);                                          // 3 entries
  u16(0x010f); u16(2); u32(8); u32(50);            // Make, ASCII, len 8, @50
  u16(0x0112); u16(3); u32(1); u16(6); u16(0);     // Orientation = 6 (rotate 90)
  u16(0x8825); u16(4); u32(1); u32(58);            // GPS IFD pointer -> @58
  u32(0);                                          // next IFD
  b.push(...'LeakCam\0'.split('').map(c => c.charCodeAt(0)));   // @50
  // GPS IFD @58: 1 entry (GPSLatitudeRef "N")
  u16(1); u16(0x0001); u16(2); u32(2); b.push(78, 0, 0, 0); u32(0);
  return b;
}

console.log('corpus written to test/corpus/');
