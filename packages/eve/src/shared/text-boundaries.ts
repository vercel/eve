/**
 * Shared grapheme-cluster boundaries for editable text. JavaScript offsets
 * stay UTF-16 offsets; segmentation defines which offsets are legal caret
 * positions and which spans editing operations may remove.
 */

interface GraphemeSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Splits text into grapheme clusters while preserving `String.slice` offsets. */
export function graphemes(text: string): GraphemeSpan[] {
  return Array.from(graphemeSegmenter.segment(text), ({ index, segment }) => ({
    text: segment,
    start: index,
    end: index + segment.length,
  }));
}

/** The nearest grapheme boundary strictly before `offset`. */
export function previousGraphemeBoundary(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (clamped === 0) return 0;
  return graphemeSegmenter.segment(text).containing(clamped - 1)?.index ?? 0;
}

/** The nearest grapheme boundary strictly after `offset`. */
export function nextGraphemeBoundary(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (clamped === text.length) return clamped;
  const grapheme = graphemeSegmenter.segment(text).containing(clamped);
  return grapheme === undefined ? text.length : grapheme.index + grapheme.segment.length;
}

/** The nearest grapheme boundary at or after `offset`. */
export function graphemeBoundaryAtOrAfter(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (clamped === 0 || clamped === text.length) return clamped;
  const grapheme = graphemeSegmenter.segment(text).containing(clamped);
  if (grapheme === undefined || grapheme.index === clamped) return clamped;
  return grapheme.index + grapheme.segment.length;
}
