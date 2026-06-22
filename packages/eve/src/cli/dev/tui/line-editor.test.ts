import { describe, expect, it } from "vitest";

import {
  PromptHistory,
  applyLineEditorKey,
  backspace,
  deleteForward,
  deleteWord,
  insert,
  killToEnd,
  killToStart,
  layoutPromptInput,
  lineOf,
  moveEnd,
  moveHome,
  moveLeft,
  movePromptLine,
  moveRight,
  visibleLine,
} from "./line-editor.js";

describe("line editing", () => {
  it("inserts at the caret and advances it", () => {
    let line = lineOf("helo");
    line = moveLeft(line); // caret before "o"
    line = insert(line, "l");
    expect(line).toEqual({ text: "hello", cursor: 4 });
  });

  it("allows newlines only in multiline inputs", () => {
    const paste = { type: "text", value: "one\ntwo", framing: "bracketed-paste" } as const;
    expect(applyLineEditorKey(lineOf(""), paste, { multiline: true })).toEqual({
      text: "one\ntwo",
      cursor: 7,
    });
    expect(applyLineEditorKey(lineOf(""), paste)).toEqual({ text: "one two", cursor: 7 });
    expect(applyLineEditorKey(lineOf("a"), { type: "newline" }, { multiline: true })).toEqual({
      text: "a\n",
      cursor: 2,
    });
    expect(applyLineEditorKey(lineOf("a"), { type: "newline" })).toBeUndefined();
  });

  it("backspaces the character before the caret", () => {
    const line = backspace({ text: "abc", cursor: 2 });
    expect(line).toEqual({ text: "ac", cursor: 1 });
  });

  it("moves and deletes by grapheme instead of UTF-16 code unit", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `A${family}B`;
    const beforeB = 1 + family.length;

    expect(moveLeft({ text, cursor: beforeB })).toEqual({ text, cursor: 1 });
    expect(moveRight({ text, cursor: 1 })).toEqual({ text, cursor: beforeB });
    expect(backspace({ text, cursor: beforeB })).toEqual({ text: "AB", cursor: 1 });
    expect(deleteForward({ text, cursor: 1 })).toEqual({ text: "AB", cursor: 1 });

    const accented = "Ae\u0301B";
    expect(backspace({ text: accented, cursor: 3 })).toEqual({ text: "AB", cursor: 1 });
  });

  it("keeps the cursor on a grapheme boundary when insertion joins characters", () => {
    expect(insert({ text: "👨👩", cursor: 2 }, "\u200d")).toEqual({
      text: "👨‍👩",
      cursor: 5,
    });
  });

  it("backspace at the start is a no-op", () => {
    const line = { text: "abc", cursor: 0 };
    expect(backspace(line)).toBe(line);
  });

  it("forward-deletes the character at the caret", () => {
    expect(deleteForward({ text: "abc", cursor: 1 })).toEqual({ text: "ac", cursor: 1 });
    const atEnd = { text: "abc", cursor: 3 };
    expect(deleteForward(atEnd)).toBe(atEnd);
  });

  it("moves the caret left/right within bounds", () => {
    expect(moveLeft({ text: "ab", cursor: 0 })).toEqual({ text: "ab", cursor: 0 });
    expect(moveRight({ text: "ab", cursor: 2 })).toEqual({ text: "ab", cursor: 2 });
    expect(moveRight({ text: "ab", cursor: 1 })).toEqual({ text: "ab", cursor: 2 });
  });

  it("jumps home and end", () => {
    expect(moveHome({ text: "abc", cursor: 2 })).toEqual({ text: "abc", cursor: 0 });
    expect(moveEnd({ text: "abc", cursor: 0 })).toEqual({ text: "abc", cursor: 3 });
    expect(moveHome({ text: "\nsecond", cursor: 0 })).toEqual({ text: "\nsecond", cursor: 0 });
    expect(moveHome({ text: "one\ntwo", cursor: 6 })).toEqual({ text: "one\ntwo", cursor: 4 });
    expect(moveEnd({ text: "one\ntwo", cursor: 1 })).toEqual({ text: "one\ntwo", cursor: 3 });
  });

  it("kills to the end and to the start", () => {
    expect(killToEnd({ text: "hello world", cursor: 5 })).toEqual({ text: "hello", cursor: 5 });
    expect(killToStart({ text: "hello world", cursor: 6 })).toEqual({ text: "world", cursor: 0 });
    expect(killToEnd({ text: "one\ntwo", cursor: 0 })).toEqual({ text: "\ntwo", cursor: 0 });
    expect(killToEnd({ text: "one\ntwo", cursor: 3 })).toEqual({ text: "one\ntwo", cursor: 3 });
    expect(killToStart({ text: "one\ntwo", cursor: 7 })).toEqual({ text: "one\n", cursor: 4 });
    expect(killToStart({ text: "one\ntwo", cursor: 4 })).toEqual({ text: "one\ntwo", cursor: 4 });
  });

  it("deletes the previous word", () => {
    expect(deleteWord({ text: "one two three", cursor: 13 })).toEqual({
      text: "one two ",
      cursor: 8,
    });
    expect(deleteWord({ text: "trailing   ", cursor: 11 })).toEqual({ text: "", cursor: 0 });
  });

  it("bounds delete-word to the current line", () => {
    // Deletes within the current line, leaving the newline and the line above.
    expect(deleteWord({ text: "one\ntwo", cursor: 7 })).toEqual({ text: "one\n", cursor: 4 });
    // At the start of a line there is nothing on it to delete; no line merge.
    expect(deleteWord({ text: "one\ntwo", cursor: 4 })).toEqual({ text: "one\ntwo", cursor: 4 });
  });

  it("routes editing keys while leaving controller keys unhandled", () => {
    const line = { text: "abc", cursor: 1 };

    expect(applyLineEditorKey(line, { type: "text", value: "X", framing: "unframed" })).toEqual({
      text: "aXbc",
      cursor: 2,
    });
    expect(applyLineEditorKey(line, { type: "ctrl-e" })).toEqual({
      text: "abc",
      cursor: 3,
    });
    expect(applyLineEditorKey(line, { type: "enter" })).toBeUndefined();
    expect(applyLineEditorKey(line, { type: "escape" })).toBeUndefined();
  });
});

describe("visibleLine", () => {
  it("shows the whole line when it fits, split at the caret", () => {
    expect(visibleLine({ text: "hello", cursor: 2 }, 80)).toEqual({
      before: "he",
      under: "l",
      after: "lo",
    });
  });

  it("keeps the grapheme under the caret intact", () => {
    expect(visibleLine({ text: "A👨‍👩‍👧‍👦B", cursor: 1 }, 80)).toEqual({
      before: "A",
      under: "👨‍👩‍👧‍👦",
      after: "B",
    });
  });

  it("windows a long line and keeps the caret visible", () => {
    const text = "0123456789abcdef";
    const { before, after } = visibleLine({ text, cursor: text.length }, 6, "…");
    const { under } = visibleLine({ text, cursor: text.length }, 6, "…");
    const visible = before + under + after;
    expect(visible.length).toBe(6);
    // Caret sits at the end of the window; the truncated head is marked.
    expect(after).toBe("");
    expect(visible.startsWith("…")).toBe(true);
  });

  it("marks a truncated tail when the caret is near the start", () => {
    const text = "0123456789abcdef";
    const { before, under, after } = visibleLine({ text, cursor: 0 }, 6, "…");
    expect(before).toBe("");
    expect((before + under + after).endsWith("…")).toBe(true);
  });
});

describe("PromptHistory", () => {
  it("cycles back through previous entries with up, then forward with down", () => {
    const history = new PromptHistory();
    history.add("first");
    history.add("second");

    history.begin("draft");
    expect(history.previous("draft")).toBe("second");
    expect(history.previous("second")).toBe("first");
    // At the oldest entry, further up does nothing.
    expect(history.previous("first")).toBeUndefined();

    expect(history.next()).toBe("second");
    // Past the newest entry restores the in-progress draft.
    expect(history.next()).toBe("draft");
    expect(history.next()).toBeUndefined();
  });

  it("ignores blank entries and consecutive duplicates", () => {
    const history = new PromptHistory();
    history.add("   ");
    history.add("hello");
    history.add("hello");

    history.begin("");
    expect(history.previous("")).toBe("hello");
    expect(history.previous("hello")).toBeUndefined();
  });
});

describe("layoutPromptInput", () => {
  it("keeps a short single line as one row with the caret in place", () => {
    const layout = layoutPromptInput({ text: "hello", cursor: 2 });
    expect(layout.rows).toEqual([{ text: "hello", start: 0 }]);
    expect({ caretRow: layout.caretRow, caretOffset: layout.caretOffset }).toEqual({
      caretRow: 0,
      caretOffset: 2,
    });
  });

  it("breaks on embedded newlines, one row per logical line", () => {
    const layout = layoutPromptInput({ text: "ab\ncd", cursor: 4 });
    expect(layout.rows).toEqual([
      { text: "ab", start: 0 },
      { text: "cd", start: 3 },
    ]);
    // Cursor 4 is the "d": second row (start 3), offset 1.
    expect({ caretRow: layout.caretRow, caretOffset: layout.caretOffset }).toEqual({
      caretRow: 1,
      caretOffset: 1,
    });
  });

  it("places the caret at the end of a line when it sits on the newline", () => {
    const layout = layoutPromptInput({ text: "ab\ncd", cursor: 2 });
    expect({ caretRow: layout.caretRow, caretOffset: layout.caretOffset }).toEqual({
      caretRow: 0,
      caretOffset: 2,
    });
  });

  it("keeps blank lines as their own row", () => {
    const layout = layoutPromptInput({ text: "a\n\nb", cursor: 3 });
    expect(layout.rows).toEqual([
      { text: "a", start: 0 },
      { text: "", start: 2 },
      { text: "b", start: 3 },
    ]);
    expect(layout.caretRow).toBe(2);
  });

  it("does not wrap a long line; it stays one row for the renderer to clip", () => {
    const layout = layoutPromptInput({ text: "abcdefgh", cursor: 5 });
    expect(layout.rows).toEqual([{ text: "abcdefgh", start: 0 }]);
    expect({ caretRow: layout.caretRow, caretOffset: layout.caretOffset }).toEqual({
      caretRow: 0,
      caretOffset: 5,
    });
  });

  it("moves between rows by terminal column without splitting graphemes", () => {
    expect(movePromptLine({ text: "界x\nab", cursor: 5 }, "up")).toEqual({
      text: "界x\nab",
      cursor: 1,
    });
    expect(movePromptLine({ text: "e\u0301x\nab", cursor: 6 }, "up")).toEqual({
      text: "e\u0301x\nab",
      cursor: 3,
    });
  });
});
