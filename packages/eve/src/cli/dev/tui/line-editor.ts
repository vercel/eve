import type { TerminalKey } from "./stream-format.js";
import {
  graphemeBoundaryAtOrAfter,
  graphemes,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
} from "#shared/text-boundaries.js";
import { inputTextWidth, offsetAtVisibleColumn } from "#cli/ui/terminal-text.js";

export interface LineState {
  readonly text: string;
  readonly cursor: number;
}

export const EMPTY_LINE: LineState = { text: "", cursor: 0 };

export function lineOf(text: string): LineState {
  return { text, cursor: text.length };
}

export function maskLine(state: LineState): LineState {
  return {
    text: "•".repeat(graphemes(state.text).length),
    cursor: graphemes(state.text.slice(0, state.cursor)).length,
  };
}

export function insert(state: LineState, value: string): LineState {
  if (value.length === 0) return state;
  const text = state.text.slice(0, state.cursor) + value + state.text.slice(state.cursor);
  const cursor = graphemeBoundaryAtOrAfter(text, state.cursor + value.length);
  return { text, cursor };
}

export function backspace(state: LineState): LineState {
  if (state.cursor === 0) return state;
  const cursor = previousGraphemeBoundary(state.text, state.cursor);
  const text = state.text.slice(0, cursor) + state.text.slice(state.cursor);
  return { text, cursor: graphemeBoundaryAtOrAfter(text, cursor) };
}

export function deleteForward(state: LineState): LineState {
  if (state.cursor >= state.text.length) return state;
  const end = nextGraphemeBoundary(state.text, state.cursor);
  const text = state.text.slice(0, state.cursor) + state.text.slice(end);
  return { text, cursor: graphemeBoundaryAtOrAfter(text, state.cursor) };
}

export function moveLeft(state: LineState): LineState {
  return state.cursor === 0
    ? state
    : { text: state.text, cursor: previousGraphemeBoundary(state.text, state.cursor) };
}

export function moveRight(state: LineState): LineState {
  return state.cursor >= state.text.length
    ? state
    : { text: state.text, cursor: nextGraphemeBoundary(state.text, state.cursor) };
}

export function moveWordBackward(state: LineState): LineState {
  let cursor = state.cursor;
  while (cursor > 0) {
    const previous = previousGraphemeBoundary(state.text, cursor);
    if (isWordCharacter(state.text.slice(previous, cursor))) break;
    cursor = previous;
  }
  while (cursor > 0) {
    const previous = previousGraphemeBoundary(state.text, cursor);
    if (!isWordCharacter(state.text.slice(previous, cursor))) break;
    cursor = previous;
  }
  return cursor === state.cursor ? state : { text: state.text, cursor };
}

export function moveWordForward(state: LineState): LineState {
  let cursor = state.cursor;
  while (cursor < state.text.length) {
    const next = nextGraphemeBoundary(state.text, cursor);
    if (isWordCharacter(state.text.slice(cursor, next))) break;
    cursor = next;
  }
  while (cursor < state.text.length) {
    const next = nextGraphemeBoundary(state.text, cursor);
    if (!isWordCharacter(state.text.slice(cursor, next))) break;
    cursor = next;
  }
  return cursor === state.cursor ? state : { text: state.text, cursor };
}

export function moveHome(state: LineState): LineState {
  const cursor = logicalLineStart(state.text, state.cursor);
  return state.cursor === cursor ? state : { text: state.text, cursor };
}

export function moveEnd(state: LineState): LineState {
  const cursor = logicalLineEnd(state.text, state.cursor);
  return state.cursor === cursor ? state : { text: state.text, cursor };
}

export function killToEnd(state: LineState): LineState {
  const lineEnd = logicalLineEnd(state.text, state.cursor);
  if (state.cursor >= lineEnd) return state;
  return {
    text: state.text.slice(0, state.cursor) + state.text.slice(lineEnd),
    cursor: state.cursor,
  };
}

export function killToStart(state: LineState): LineState {
  const lineStart = logicalLineStart(state.text, state.cursor);
  if (state.cursor <= lineStart) return state;
  return {
    text: state.text.slice(0, lineStart) + state.text.slice(state.cursor),
    cursor: lineStart,
  };
}

export function deleteWordBackward(state: LineState): LineState {
  const start = moveWordBackward(state).cursor;
  if (start === state.cursor) return state;
  const text = state.text.slice(0, start) + state.text.slice(state.cursor);
  return { text, cursor: graphemeBoundaryAtOrAfter(text, start) };
}

export function deleteWord(state: LineState): LineState {
  if (state.cursor === 0) return state;
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

interface LineEditorOptions {
  readonly multiline?: boolean;
}

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
    case "ctrl-b":
      return moveLeft(state);
    case "right":
    case "ctrl-f":
      return moveRight(state);
    case "alt-b":
      return moveWordBackward(state);
    case "alt-f":
      return moveWordForward(state);
    case "alt-backspace":
      return deleteWordBackward(state);
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

interface YankState {
  readonly state: LineState;
  readonly start: number;
  readonly replacementEnd: number;
  readonly ringIndex: number;
}

export class KillRing {
  readonly #entries: string[] = [];
  readonly #capacity: number;
  #yank?: YankState;

  constructor(capacity = 20) {
    this.#capacity = capacity;
  }

  clear(): void {
    this.#entries.length = 0;
    this.#yank = undefined;
  }

  interruptYank(key: TerminalKey): void {
    if (key.type !== "ctrl-y" && key.type !== "alt-y") this.#yank = undefined;
  }

  apply(state: LineState, key: TerminalKey, options?: LineEditorOptions): LineState | undefined {
    if (key.type === "ctrl-y") return this.#yankLatest(state);
    if (key.type === "alt-y") return this.#yankPrevious(state);

    this.#yank = undefined;
    const next = applyLineEditorKey(state, key, options);
    if (next !== undefined) this.#record(killedText(state, next, key));
    return next;
  }

  #record(text: string): void {
    if (text.length === 0 || this.#capacity <= 0) return;
    this.#entries.unshift(text);
    if (this.#entries.length > this.#capacity) this.#entries.length = this.#capacity;
  }

  #yankLatest(state: LineState): LineState {
    const text = this.#entries[0];
    if (text === undefined) {
      this.#yank = undefined;
      return state;
    }
    const next = insert(state, text);
    this.#yank = {
      state: next,
      start: state.cursor,
      replacementEnd: state.cursor + text.length,
      ringIndex: 0,
    };
    return next;
  }

  #yankPrevious(state: LineState): LineState {
    const yank = this.#yank;
    if (yank === undefined || this.#entries.length < 2 || state !== yank.state) return state;
    const ringIndex = (yank.ringIndex + 1) % this.#entries.length;
    const text = this.#entries[ringIndex]!;
    const replacementEnd = yank.start + text.length;
    const nextText = state.text.slice(0, yank.start) + text + state.text.slice(yank.replacementEnd);
    const next = {
      text: nextText,
      cursor: graphemeBoundaryAtOrAfter(nextText, replacementEnd),
    };
    this.#yank = { state: next, start: yank.start, replacementEnd, ringIndex };
    return next;
  }
}

function killedText(before: LineState, after: LineState, key: TerminalKey): string {
  switch (key.type) {
    case "ctrl-k":
      return before.text.slice(before.cursor, logicalLineEnd(before.text, before.cursor));
    case "ctrl-u":
    case "ctrl-w":
      return before.text.slice(after.cursor, before.cursor);
    default:
      return "";
  }
}

function isWhitespace(text: string): boolean {
  return /^\s+$/u.test(text);
}

function isWordCharacter(text: string): boolean {
  return /^[\p{L}\p{M}\p{N}_]/u.test(text);
}

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

interface PromptLogicalRow {
  readonly text: string;
  readonly start: number;
}

interface PromptLayout {
  readonly rows: PromptLogicalRow[];
  readonly caretRow: number;
  readonly caretOffset: number;
}

export function layoutPromptInput(state: LineState): PromptLayout {
  const rows: PromptLogicalRow[] = [];
  let caretRow = 0;
  let caretOffset = 0;

  let start = 0;
  for (const text of state.text.split("\n")) {
    if (state.cursor >= start && state.cursor <= start + text.length) {
      caretRow = rows.length;
      caretOffset = state.cursor - start;
    }
    rows.push({ text, start });
    start += text.length + 1;
  }

  return { rows, caretRow, caretOffset };
}

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

export class PromptHistory {
  readonly #entries: string[] = [];
  #index = 0;
  #draft = "";

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

  begin(draft: string): void {
    this.#index = this.#entries.length;
    this.#draft = draft;
  }

  previous(currentDraft: string): string | undefined {
    if (this.#entries.length === 0) return undefined;
    if (this.#index === this.#entries.length) this.#draft = currentDraft;
    if (this.#index === 0) return undefined;
    this.#index -= 1;
    return this.#entries[this.#index];
  }

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
