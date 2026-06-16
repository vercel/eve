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
  lineOf,
  moveEnd,
  moveHome,
  moveLeft,
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

  it("backspaces the character before the caret", () => {
    const line = backspace({ text: "abc", cursor: 2 });
    expect(line).toEqual({ text: "ac", cursor: 1 });
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
  });

  it("kills to the end and to the start", () => {
    expect(killToEnd({ text: "hello world", cursor: 5 })).toEqual({ text: "hello", cursor: 5 });
    expect(killToStart({ text: "hello world", cursor: 6 })).toEqual({ text: "world", cursor: 0 });
  });

  it("deletes the previous word", () => {
    expect(deleteWord({ text: "one two three", cursor: 13 })).toEqual({
      text: "one two ",
      cursor: 8,
    });
    expect(deleteWord({ text: "trailing   ", cursor: 11 })).toEqual({ text: "", cursor: 0 });
  });

  it("routes editing keys while leaving controller keys unhandled", () => {
    const line = { text: "abc", cursor: 1 };

    expect(applyLineEditorKey(line, { type: "character", value: "X" })).toEqual({
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
    expect(visibleLine({ text: "hello", cursor: 2 }, 80)).toEqual({ before: "he", after: "llo" });
  });

  it("windows a long line and keeps the caret visible", () => {
    const text = "0123456789abcdef";
    const { before, after } = visibleLine({ text, cursor: text.length }, 6, "…");
    const visible = before + after;
    expect(visible.length).toBe(6);
    // Caret sits at the end of the window; the truncated head is marked.
    expect(after).toBe("");
    expect(visible.startsWith("…")).toBe(true);
  });

  it("marks a truncated tail when the caret is near the start", () => {
    const text = "0123456789abcdef";
    const { before, after } = visibleLine({ text, cursor: 0 }, 6, "…");
    expect(before).toBe("");
    expect((before + after).endsWith("…")).toBe(true);
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
