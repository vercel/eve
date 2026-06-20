import { graphemes } from "#shared/text-boundaries.js";

const ansiEscape = String.fromCharCode(27);

export const ansiPattern = new RegExp(`${ansiEscape}\\[[0-?]*[ -/]*[@-~]`, "g");
export const ansiPrefixPattern = new RegExp(`^${ansiEscape}\\[[0-?]*[ -/]*[@-~]`);
const emojiPresentationPattern = /\p{Emoji_Presentation}/u;
const extendedPictographicPattern = /\p{Extended_Pictographic}/u;
const keycapPattern = /^[#*0-9]\u{fe0f}?\u{20e3}$/u;

export function stripAnsi(input: string): string {
  return stripTerminalControls(input.replaceAll(ansiPattern, ""));
}

export function stripTerminalControls(input: string): string {
  let output = "";
  let index = 0;

  while (index < input.length) {
    const codePoint = input.codePointAt(index);

    if (codePoint == null) {
      break;
    }

    const character = String.fromCodePoint(codePoint);
    index += character.length;

    if (isUnsafeTerminalControlCodePoint(codePoint)) {
      continue;
    }

    output += character;
  }

  return output;
}

export function visibleLength(input: string): number {
  let width = 0;
  for (const unit of terminalTextUnits(input)) width += unit.width;
  return width;
}

export function sliceVisible(input: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  let output = "";
  let visible = 0;
  const units = terminalTextUnits(input);
  let index = 0;
  while (index < units.length && visible < width) {
    const unit = units[index]!;
    if (unit.width > 0 && visible + unit.width > width) break;
    output += unit.text;
    visible += unit.width;
    index += 1;
  }

  while (units[index]?.ansi === true) {
    output += units[index]!.text;
    index += 1;
  }

  return output;
}

/** Clips text styled only at grapheme boundaries, resetting any truncated style. */
export function clipVisible(input: string, width: number): string {
  if (visibleLength(input) <= width) return input;
  const sliced = sliceVisible(input, width);
  return sliced.includes(ansiEscape) ? `${sliced}${ansiEscape}[0m` : sliced;
}

/** Terminal-cell width of editor text, measured one grapheme cluster at a time. */
export function inputTextWidth(input: string): number {
  let width = 0;
  for (const grapheme of graphemes(input)) {
    width += terminalGraphemeWidth(grapheme.text);
  }
  return width;
}

/** Expands editor tabs to the same fixed four cells used by {@link inputTextWidth}. */
export function renderInputText(input: string): string {
  return input.replaceAll("\t", "    ");
}

/**
 * Returns the UTF-16 offset at or immediately before a terminal column.
 * Graphemes stay intact even when the requested column falls inside a wide one.
 */
export function offsetAtVisibleColumn(input: string, column: number): number {
  if (column <= 0) return 0;

  let visible = 0;
  for (const grapheme of graphemes(input)) {
    const next = visible + terminalGraphemeWidth(grapheme.text);
    if (next > column) return grapheme.start;
    if (next === column) return grapheme.end;
    visible = next;
  }
  return input.length;
}

function terminalGraphemeWidth(grapheme: string): number {
  let width = 0;
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) width = Math.max(width, codePointWidth(codePoint));
  }
  const emojiPresentation =
    emojiPresentationPattern.test(grapheme) ||
    keycapPattern.test(grapheme) ||
    (grapheme.includes("\u{fe0f}") && extendedPictographicPattern.test(grapheme));
  return emojiPresentation ? Math.max(2, width) : width;
}

interface TerminalTextUnit {
  readonly text: string;
  readonly width: number;
  readonly ansi: boolean;
}

function terminalTextUnits(input: string): TerminalTextUnit[] {
  const units: TerminalTextUnit[] = [];
  let index = 0;
  while (index < input.length) {
    const remaining = input.slice(index);
    const ansiMatch = remaining.match(ansiPrefixPattern);
    if (ansiMatch !== null) {
      units.push({ text: ansiMatch[0], width: 0, ansi: true });
      index += ansiMatch[0].length;
      continue;
    }

    const nextAnsi = remaining.search(ansiPattern);
    const plain = remaining.slice(0, nextAnsi === -1 ? remaining.length : nextAnsi);
    for (const grapheme of graphemes(plain)) {
      units.push({ text: grapheme.text, width: terminalGraphemeWidth(grapheme.text), ansi: false });
    }
    index += plain.length;
  }
  return units;
}

/**
 * Word-wraps a single logical line to `width` visible columns, preserving
 * ANSI styling and never splitting inside an escape sequence. Breaks on the
 * last space that fits; falls back to a hard cut for unbreakable runs.
 */
export function wrapVisibleLine(line: string, width: number): string[] {
  if (width <= 0) {
    return [line];
  }

  if (line.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let remaining = line;

  while (visibleLength(remaining) > width) {
    const breakAt = findVisibleBreakPoint(remaining, width);
    lines.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }

  if (remaining.length > 0 || lines.length === 0) lines.push(remaining);
  return lines;
}

function findVisibleBreakPoint(input: string, width: number): number {
  const slice = sliceVisible(input, width + 1);
  const lastSpace = slice.lastIndexOf(" ");

  if (lastSpace > 0) {
    return lastSpace;
  }

  const hardSlice = sliceVisible(input, width);
  if (visibleLength(hardSlice) > 0) return hardSlice.length;

  let offset = 0;
  let foundVisibleUnit = false;
  for (const unit of terminalTextUnits(input)) {
    if (foundVisibleUnit && unit.width > 0) return offset;
    offset += unit.text.length;
    if (unit.width > 0) foundVisibleUnit = true;
  }
  return offset;
}

export function codePointWidth(codePoint: number): number {
  if (codePoint === 0x09) {
    return 4;
  }

  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }

  if (isZeroWidthCodePoint(codePoint)) {
    return 0;
  }

  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isUnsafeTerminalControlCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x00 && codePoint <= 0x08) ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0483 && codePoint <= 0x0489) ||
    (codePoint >= 0x0591 && codePoint <= 0x05bd) ||
    codePoint === 0x05bf ||
    (codePoint >= 0x05c1 && codePoint <= 0x05c2) ||
    (codePoint >= 0x05c4 && codePoint <= 0x05c5) ||
    codePoint === 0x05c7 ||
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06dc) ||
    (codePoint >= 0x06df && codePoint <= 0x06e4) ||
    (codePoint >= 0x06e7 && codePoint <= 0x06e8) ||
    (codePoint >= 0x06ea && codePoint <= 0x06ed) ||
    codePoint === 0x0711 ||
    (codePoint >= 0x0730 && codePoint <= 0x074a) ||
    (codePoint >= 0x07a6 && codePoint <= 0x07b0) ||
    (codePoint >= 0x07eb && codePoint <= 0x07f3) ||
    (codePoint >= 0x0816 && codePoint <= 0x0819) ||
    (codePoint >= 0x081b && codePoint <= 0x0823) ||
    (codePoint >= 0x0825 && codePoint <= 0x0827) ||
    (codePoint >= 0x0829 && codePoint <= 0x082d) ||
    (codePoint >= 0x0859 && codePoint <= 0x085b) ||
    (codePoint >= 0x08d3 && codePoint <= 0x0902) ||
    codePoint === 0x093a ||
    codePoint === 0x093c ||
    (codePoint >= 0x0941 && codePoint <= 0x0948) ||
    codePoint === 0x094d ||
    (codePoint >= 0x0951 && codePoint <= 0x0957) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}
