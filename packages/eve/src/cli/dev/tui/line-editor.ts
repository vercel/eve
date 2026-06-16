/**
 * A tiny, dependency-free line-editing model for the prompt input.
 *
 * The renderer owns the terminal; this module owns the *text* — a single
 * logical line plus a caret position — and exposes pure transforms for the
 * common readline-style edits (insert, delete, word/line kill, cursor moves)
 * and a {@link visibleLine} helper that windows a long line around the caret
 * so it stays on screen. Keeping it pure makes the editing rules trivial to
 * unit test without a TTY.
 */

import type { TerminalKey } from "./stream-format.js";

/** One logical input line: its text and the caret's index within it. */
export interface LineState {
  readonly text: string;
  readonly cursor: number;
}

/** The empty line with the caret at column 0. */
export const EMPTY_LINE: LineState = { text: "", cursor: 0 };

/** Builds a line from `text` with the caret placed at the end. */
export function lineOf(text: string): LineState {
  return { text, cursor: text.length };
}

/** Inserts `value` at the caret and advances the caret past it. */
export function insert(state: LineState, value: string): LineState {
  if (value.length === 0) return state;
  const text = state.text.slice(0, state.cursor) + value + state.text.slice(state.cursor);
  return { text, cursor: state.cursor + value.length };
}

/** Deletes the character before the caret (Backspace). */
export function backspace(state: LineState): LineState {
  if (state.cursor === 0) return state;
  const text = state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor);
  return { text, cursor: state.cursor - 1 };
}

/** Deletes the character at the caret (Delete / Ctrl+D mid-line). */
export function deleteForward(state: LineState): LineState {
  if (state.cursor >= state.text.length) return state;
  const text = state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1);
  return { text, cursor: state.cursor };
}

/** Moves the caret one column left. */
export function moveLeft(state: LineState): LineState {
  return state.cursor === 0 ? state : { text: state.text, cursor: state.cursor - 1 };
}

/** Moves the caret one column right. */
export function moveRight(state: LineState): LineState {
  return state.cursor >= state.text.length ? state : { text: state.text, cursor: state.cursor + 1 };
}

/** Moves the caret to the start of the line (Home / Ctrl+A). */
export function moveHome(state: LineState): LineState {
  return state.cursor === 0 ? state : { text: state.text, cursor: 0 };
}

/** Moves the caret to the end of the line (End / Ctrl+E). */
export function moveEnd(state: LineState): LineState {
  return state.cursor === state.text.length
    ? state
    : { text: state.text, cursor: state.text.length };
}

/** Deletes from the caret to the end of the line (Ctrl+K). */
export function killToEnd(state: LineState): LineState {
  if (state.cursor >= state.text.length) return state;
  return { text: state.text.slice(0, state.cursor), cursor: state.cursor };
}

/** Deletes from the start of the line to the caret (Ctrl+U). */
export function killToStart(state: LineState): LineState {
  if (state.cursor === 0) return state;
  return { text: state.text.slice(state.cursor), cursor: 0 };
}

/** Deletes the whitespace-delimited word before the caret (Ctrl+W). */
export function deleteWord(state: LineState): LineState {
  if (state.cursor === 0) return state;
  let start = state.cursor;
  while (start > 0 && isWhitespace(state.text[start - 1])) start -= 1;
  while (start > 0 && !isWhitespace(state.text[start - 1])) start -= 1;
  return { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start };
}

/**
 * Applies a key owned by the single-line editor. Returns `undefined` when the
 * key belongs to the surrounding controller (submit, cancel, history, menus).
 */
export function applyLineEditorKey(state: LineState, key: TerminalKey): LineState | undefined {
  switch (key.type) {
    case "character":
      return insert(state, key.value);
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

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char);
}

/**
 * The portion of `state.text` to draw within `budget` columns, split at the
 * caret so the renderer can place its caret glyph between `before` and
 * `after`. When the line is wider than `budget` it is windowed around the
 * caret, marking truncated ends with `…` so the caret is always visible.
 */
export interface VisibleLine {
  readonly before: string;
  readonly after: string;
}

export function visibleLine(state: LineState, budget: number, ellipsis = "…"): VisibleLine {
  const width = Math.max(1, budget);
  const { text, cursor } = state;

  if (text.length <= width) {
    return { before: text.slice(0, cursor), after: text.slice(cursor) };
  }

  // Window the line so the caret stays on screen, keeping a little context
  // ahead of the caret when scrolling right.
  let start = cursor < width ? 0 : cursor - width + 1;
  start = Math.min(start, text.length - width);
  start = Math.max(0, start);
  const end = start + width;

  let visible = text.slice(start, end);
  const rel = cursor - start;
  if (start > 0 && rel > 0) {
    visible = ellipsis + visible.slice(ellipsis.length);
  }
  if (end < text.length && rel < visible.length) {
    visible = visible.slice(0, visible.length - ellipsis.length) + ellipsis;
  }

  return { before: visible.slice(0, rel), after: visible.slice(rel) };
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
