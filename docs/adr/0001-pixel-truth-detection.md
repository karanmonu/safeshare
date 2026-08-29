# ADR 0001: Detect fake redactions by comparing pixel truth to text truth

Status: accepted · 2026-08-29

## Context

A "fake redaction" is text hidden visually but still machine-extractable. It can
be produced at least four ways: a filled vector rectangle over live text, a dark
Square/Highlight annotation, a /Redact annotation that was never applied, or a
black bar burned into a scanned image whose OCR text layer still carries the words.

Prior art detects a subset. Free Law Project's x-ray parses content streams and
looks for dark rectangles whose geometry intersects text — it catches the vector
case, and only that case. Content-stream parsing must also reimplement the PDF
graphics model (transform stacks, color spaces, pattern fills, form XObjects) to
know what a shape finally looks like, and every miss is a false negative.

## Decision

Render the page with pdf.js — the same renderer a human's browser uses — and
compare against the extractable text layer. For every text item, sample the
luminance of the pixels where that text sits. Extractable text on near-uniform
dark pixels (mean luminance < 64, stddev < 18) is reported as recoverable, and
we show exactly the text an attacker would copy out.

The renderer resolves the entire graphics model for us, so the check is
indifferent to HOW the cover was drawn: vector rects, annotations, and
OCR-under-image all collapse into the same observable — dark pixels where
machine-readable text lives. Unapplied /Redact annotations don't hide pixels at
all, so they are detected separately from the annotation list.

## Consequences

- One detector covers vector, annotation, and OCR-layer fake redactions,
  including methods we haven't seen yet, because it tests the outcome rather
  than the technique.
- Requires rendering, so analysis costs ~100–300 ms per page. Acceptable for a
  one-document workflow; batch/CLI mode may need a content-stream fast path.
- Light text on dark banners (title-slide designs) is NOT flagged: visible
  glyph pixels raise the variance inside the sampled box above the uniformity
  threshold, and the corpus pins this (`white-on-dark.pdf`). Residual risk:
  very small or ultra-thin glyphs could slip under the sampling grid; if that
  shows up in the field, the fix is denser sampling or an operator-list check
  of the text's own fill color.
- Known false negative: text hidden by non-dark covers (white boxes, images of
  the page). White-cover detection needs the text-color check above; the
  "page is one big image but has a text layer" case is partially covered by the
  same luminance test whenever the burned-in bar is dark.
- Thresholds live in one place at the top of pdf-analyzer.js and the corpus
  pins their behavior in CI.
