/**
 * SafeShare PDF fixer — the fixes that are safe to make deterministically.
 * v0 scope: strip info dictionary + XMP metadata. True redaction fixing
 * (glyph removal) is deliberately NOT here — see docs/adr/0001.
 * AGPL-3.0-or-later.
 */

export async function stripPdfMetadata(bytes, PDFLib) {
  const { PDFDocument, PDFName } = PDFLib;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });

  // Remove every key from the info dictionary (empty strings and epoch
  // dates still leak "this was scrubbed on <date> with <tool>").
  const infoRef = doc.context.trailerInfo.Info;
  if (infoRef) {
    const info = doc.context.lookup(infoRef);
    if (info && typeof info.keys === 'function') {
      for (const key of [...info.keys()]) info.delete(key);
    }
    delete doc.context.trailerInfo.Info;
  }

  // Remove the XMP metadata stream reference from the catalog.
  doc.catalog.delete(PDFName.of('Metadata'));

  return doc.save({ useObjectStreams: true });
}
