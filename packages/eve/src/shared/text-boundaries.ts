interface GraphemeSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string): GraphemeSpan[] {
  return Array.from(graphemeSegmenter.segment(text), ({ index, segment }) => ({
    text: segment,
    start: index,
    end: index + segment.length,
  }));
}

export function previousGraphemeBoundary(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (clamped === 0) return 0;
  return graphemeSegmenter.segment(text).containing(clamped - 1)?.index ?? 0;
}

export function nextGraphemeBoundary(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (clamped === text.length) return clamped;
  const grapheme = graphemeSegmenter.segment(text).containing(clamped);
  return grapheme === undefined ? text.length : grapheme.index + grapheme.segment.length;
}

export function graphemeBoundaryAtOrAfter(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (clamped === 0 || clamped === text.length) return clamped;
  const grapheme = graphemeSegmenter.segment(text).containing(clamped);
  if (grapheme === undefined || grapheme.index === clamped) return clamped;
  return grapheme.index + grapheme.segment.length;
}
