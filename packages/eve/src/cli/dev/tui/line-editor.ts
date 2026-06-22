/**
 * A tiny, dependency-free line-editing model for the prompt input.
 *
 * The renderer owns the terminal; this module owns the *text* — buffer plus
 * caret position, where the buffer may carry embedded newlines — and exposes
 * pure transforms for the common readline-style edits (insert, delete,
 * word/line kill, cursor moves), a {@link visibleLine} helper that windows a
 * long line around the caret, and {@link layoutPromptInput} which splits a
 * multi-line buffer into logical rows. Keeping it pure makes the editing rules
 * trivial to unit test without a TTY.
 */

import type { TerminalKey } from "./stream-format.js";
import {
  graphemeBoundaryAtOrAfter,
  graphemes,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
} from "#shared/text-boundaries.js";
import { inputTextWidth, offsetAtVisibleColumn } from "./terminal-text.js";

/**
 * Editor text and a caret at a grapheme boundary, represented as a UTF-16
 * offset so it can be passed directly to `String.slice`.
 */
export interface LineState {
  readonly text: string;
  readonly cursor: number;
}

/** The empty editor buffer with the caret at offset 0. */
export const EMPTY_LINE: LineState = { text: "", cursor: 0 };

/** Builds a line from `text` with the caret placed at the end. */
export function lineOf(text: string): LineState {
  return { text, cursor: text.length };
}

/** Masks each grapheme with one bullet while preserving the caret's grapheme position. */
export function maskLine(state: LineState): LineState {
  return {
    text: "•".repeat(graphemes(state.text).length),
    cursor: graphemes(state.text.slice(0, state.cursor)).length,
  };
}

/** Inserts `value` at the caret and advances the caret past it. */
export function insert(state: LineState, value: string): LineState {
  if (value.length === 0) return state;
  const text = state.text.slice(0, state.cursor) + value + state.text.slice(state.cursor);
  const cursor = graphemeBoundaryAtOrAfter(text, state.cursor + value.length);
  return { text, cursor };
}

/** Deletes the grapheme before the caret (Backspace). */
export function backspace(state: LineState): LineState {
  if (state.cursor === 0) return state;
  const cursor = previousGraphemeBoundary(state.text, state.cursor);
  const text = state.text.slice(0, cursor) + state.text.slice(state.cursor);
  return { text, cursor: graphemeBoundaryAtOrAfter(text, cursor) };
}

/** Deletes the grapheme at the caret (Delete / Ctrl+D mid-line). */
export function deleteForward(state: LineState): LineState {
  if (state.cursor >= state.text.length) return state;
  const end = nextGraphemeBoundary(state.text, state.cursor);
  const text = state.text.slice(0, state.cursor) + state.text.slice(end);
  return { text, cursor: graphemeBoundaryAtOrAfter(text, state.cursor) };
}

/** Moves the caret one grapheme left. */
export function moveLeft(state: LineState): LineState {
  return state.cursor === 0
    ? state
    : { text: state.text, cursor: previousGraphemeBoundary(state.text, state.cursor) };
}

/** Moves the caret one grapheme right. */
export function moveRight(state: LineState): LineState {
  return state.cursor >= state.text.length
    ? state
    : { text: state.text, cursor: nextGraphemeBoundary(state.text, state.cursor) };
}

/** Moves the caret to the start of the line (Home / Ctrl+A). */
export function moveHome(state: LineState): LineState {
  const cursor = logicalLineStart(state.text, state.cursor);
  return state.cursor === cursor ? state : { text: state.text, cursor };
}

/** Moves the caret to the end of the line (End / Ctrl+E). */
export function moveEnd(state: LineState): LineState {
  const cursor = logicalLineEnd(state.text, state.cursor);
  return state.cursor === cursor ? state : { text: state.text, cursor };
}

/** Deletes from the caret to the end of the line (Ctrl+K). */
export function killToEnd(state: LineState): LineState {
  const lineEnd = logicalLineEnd(state.text, state.cursor);
  if (state.cursor >= lineEnd) return state;
  return {
    text: state.text.slice(0, state.cursor) + state.text.slice(lineEnd),
    cursor: state.cursor,
  };
}

/** Deletes from the start of the line to the caret (Ctrl+U). */
export function killToStart(state: LineState): LineState {
  const lineStart = logicalLineStart(state.text, state.cursor);
  if (state.cursor <= lineStart) return state;
  return {
    text: state.text.slice(0, lineStart) + state.text.slice(state.cursor),
    cursor: lineStart,
  };
}

/** Deletes the whitespace-delimited word before the caret (Ctrl+W). */
export function deleteWord(state: LineState): LineState {
  if (state.cursor === 0) return state;
  // Bound to the current logical line, like killToEnd/killToStart: Ctrl+W stops
  // at the line start instead of reaching up and merging the line above.
  const lineStart = logicalLineStart(state.text, state.cursor);
  let start = state.cursor;
  while (start > lineStart) {
    const previous = previousGraphemeBoundary(state.text, start);
    if (!isWhitespace(state.text.slice(previous, start))) break;
    start = previous;
  }
  while (start > lineStart) {
    const previous = previousGraphemeBoundary(state.text, start);
    if (isWhitespace(state.text.slice(previous, start))) break;
    start = previous;
  }
  const text = state.text.slice(0, start) + state.text.slice(state.cursor);
  return { text, cursor: graphemeBoundaryAtOrAfter(text, start) };
}

function logicalLineStart(text: string, cursor: number): number {
  if (cursor === 0) return 0;
  return text.lastIndexOf("\n", cursor - 1) + 1;
}

function logicalLineEnd(text: string, cursor: number): number {
  const newline = text.indexOf("\n", cursor);
  return newline === -1 ? text.length : newline;
}

/** Options for {@link applyLineEditorKey}. */
interface LineEditorOptions {
  /** Single-line inputs flatten pasted newlines and ignore Shift+Enter. */
  readonly multiline?: boolean;
}

/**
 * Applies a key owned by the line editor. Returns `undefined` when the key
 * belongs to the surrounding controller (submit, cancel, history, menus), which
 * on a single-line input includes Shift+Enter.
 */
export function applyLineEditorKey(
  state: LineState,
  key: TerminalKey,
  options?: LineEditorOptions,
): LineState | undefined {
  const multiline = options?.multiline ?? false;
  switch (key.type) {
    case "text":
      return insert(state, multiline ? key.value : key.value.replaceAll("\n", " "));
    case "newline":
      return multiline ? insert(state, "\n") : undefined;
    case "backspace":
      return backspace(state);
    case "delete":
      return deleteForward(state);
    case "left":
      return moveLeft(state);
    case "right":
      return moveRight(state);
    case "home":
    case "ctrl-a":
      return moveHome(state);
    case "end":
    case "ctrl-e":
      return moveEnd(state);
    case "ctrl-k":
      return killToEnd(state);
    case "ctrl-u":
      return killToStart(state);
    case "ctrl-w":
      return deleteWord(state);
    default:
      return undefined;
  }
}

function isWhitespace(text: string): boolean {
  return /^\s+$/u.test(text);
}

/**
 * The portion of `state.text` to draw within `budget` columns, split at the
 * caret so the renderer can highlight `under` without slicing a grapheme.
 * When the line is wider than `budget` it is windowed around the caret,
 * marking truncated ends with `…` so the caret is always visible.
 */
interface VisibleLine {
  readonly before: string;
  readonly under: string;
  readonly after: string;
}

export function visibleLine(state: LineState, budget: number, ellipsis = "…"): VisibleLine {
  const width = Math.max(1, budget);
  const { text, cursor } = state;
  const segments = graphemes(text);
  const caretIndex = segments.findIndex((segment) => segment.start === cursor);
  const underIndex = caretIndex === -1 ? segments.length : caretIndex;
  const under = segments[underIndex]?.text ?? "";

  if (inputTextWidth(text) <= width) {
    return {
      before: text.slice(0, cursor),
      under,
      after: text.slice(cursor + under.length),
    };
  }

  let start = underIndex;
  let end = underIndex + (under.length > 0 ? 1 : 0);
  const windowWidth = (candidateStart: number, candidateEnd: number): number => {
    const startOffset = segments[candidateStart]?.start ?? text.length;
    const endOffset = segments[candidateEnd]?.start ?? text.length;
    return (
      inputTextWidth(text.slice(startOffset, endOffset)) +
      (candidateStart > 0 ? inputTextWidth(ellipsis) : 0) +
      (candidateEnd < segments.length ? inputTextWidth(ellipsis) : 0)
    );
  };

  let preferBefore = true;
  while (true) {
    const beforeFits = start > 0 && windowWidth(start - 1, end) <= width;
    const afterFits = end < segments.length && windowWidth(start, end + 1) <= width;
    if (!beforeFits && !afterFits) break;
    if ((preferBefore && beforeFits) || !afterFits) start -= 1;
    else end += 1;
    preferBefore = !preferBefore;
  }

  const startOffset = segments[start]?.start ?? text.length;
  const endOffset = segments[end]?.start ?? text.length;
  return {
    before: `${start > 0 ? ellipsis : ""}${text.slice(startOffset, cursor)}`,
    under,
    after: `${text.slice(cursor + under.length, endOffset)}${end < segments.length ? ellipsis : ""}`,
  };
}

/** One logical prompt row and the UTF-16 offset where it starts in the buffer. */
interface PromptLogicalRow {
  readonly text: string;
  readonly start: number;
}

/**
 * A multi-line prompt split into logical rows. `caretRow` indexes {@link rows};
 * `caretOffset` is a UTF-16 offset within that row.
 */
interface PromptLayout {
  readonly rows: PromptLogicalRow[];
  readonly caretRow: number;
  readonly caretOffset: number;
}

/**
 * Splits a prompt buffer on newlines and locates the caret. This function does
 * not measure terminal columns or wrap rows; the renderer windows each logical
 * row to the available width.
 */
export function layoutPromptInput(state: LineState): PromptLayout {
  const rows: PromptLogicalRow[] = [];
  let caretRow = 0;
  let caretOffset = 0;

  let start = 0;
  for (const text of state.text.split("\n")) {
    // The caret sits on this line when it falls within [start, start + length];
    // the next line begins one past the "\n", so the ranges never overlap.
    if (state.cursor >= start && state.cursor <= start + text.length) {
      caretRow = rows.length;
      caretOffset = state.cursor - start;
    }
    rows.push({ text, start });
    start += text.length + 1; // + 1 for the "\n" that split removed
  }

  return { rows, caretRow, caretOffset };
}

/** Moves to the adjacent logical line while preserving the terminal column where possible. */
export function movePromptLine(state: LineState, direction: "up" | "down"): LineState | undefined {
  const layout = layoutPromptInput(state);
  const targetRow = direction === "up" ? layout.caretRow - 1 : layout.caretRow + 1;
  if (targetRow < 0 || targetRow >= layout.rows.length) return undefined;

  const current = layout.rows[layout.caretRow]!;
  const target = layout.rows[targetRow]!;
  const column = inputTextWidth(current.text.slice(0, layout.caretOffset));
  return {
    text: state.text,
    cursor: target.start + offsetAtVisibleColumn(target.text, column),
  };
}

/**
 * In-memory, append-only prompt history with shell-style up/down navigation.
 *
 * Navigation is non-destructive: stepping back from the live line stashes the
 * in-progress draft and restores it when the user steps forward past the
 * newest entry. Consecutive duplicate submissions are collapsed.
 */
export class PromptHistory {
  readonly #entries: string[] = [];
  #index = 0;
  #draft = "";

  /** Records a submitted prompt (skips blanks and consecutive duplicates). */
  add(entry: string): void {
    const value = entry.trim();
    if (value.length === 0) return;
    if (this.#entries.at(-1) === entry) {
      this.#resetCursor();
      return;
    }
    this.#entries.push(entry);
    this.#resetCursor();
  }

  /** Resets navigation to the live line, stashing `draft` as the in-progress text. */
  begin(draft: string): void {
    this.#index = this.#entries.length;
    this.#draft = draft;
  }

  /** The previous (older) entry, or `undefined` at the oldest entry. */
  previous(currentDraft: string): string | undefined {
    if (this.#entries.length === 0) return undefined;
    if (this.#index === this.#entries.length) this.#draft = currentDraft;
    if (this.#index === 0) return undefined;
    this.#index -= 1;
    return this.#entries[this.#index];
  }

  /** The next (newer) entry, or the stashed draft once past the newest entry. */
  next(): string | undefined {
    if (this.#index >= this.#entries.length) return undefined;
    this.#index += 1;
    return this.#index === this.#entries.length ? this.#draft : this.#entries[this.#index];
  }

  #resetCursor(): void {
    this.#index = this.#entries.length;
    this.#draft = "";
  }
}
