import { describe, expect, it } from "vitest";

import {
  clipVisible,
  inputTextWidth,
  offsetAtVisibleColumn,
  renderInputText,
  sliceVisible,
  stripAnsi,
  stripTerminalControls,
  visibleLength,
  wrapVisibleLine,
} from "./terminal-text.js";

describe("stripTerminalControls", () => {
  it("removes C0 and C1 controls while preserving tabs and newlines", () => {
    const input = "a\tb\nc\rd\x00e\x08f\x0bg\x1bh\x7fi\u009dj\u009ck";

    expect(stripTerminalControls(input)).toBe("a\tb\ncdefghijk");
  });

  it("neutralizes OSC and DCS introducers", () => {
    const input = "\x1b]52;c;cGFzdGU=\x07copy \x1bPqpayload\x1b\\done \u009d0;title\u009c";

    expect(stripTerminalControls(input)).toBe("]52;c;cGFzdGU=copy Pqpayload\\done 0;title");
  });
});

describe("stripAnsi", () => {
  it("strips CSI sequences and unsafe terminal controls", () => {
    const input = "a\x1b[31mb\x1b[0mc\x1b]0;title\x07d";

    expect(stripAnsi(input)).toBe("abc]0;titled");
  });
});

describe("editable input geometry", () => {
  it("measures graphemes rather than summing their code points", () => {
    expect(inputTextWidth("界x")).toBe(3);
    expect(inputTextWidth("e\u0301")).toBe(1);
    expect(inputTextWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(inputTextWidth("🇺🇸")).toBe(2);
    expect(inputTextWidth("1️⃣")).toBe(2);
    expect(inputTextWidth("©️")).toBe(2);
    expect(inputTextWidth("A\uFE0F")).toBe(1);
    expect(inputTextWidth("\t")).toBe(4);
  });

  it("uses the same grapheme widths when clipping styled terminal text", () => {
    const family = "👨‍👩‍👧‍👦";
    const styled = `\x1b[7m${family}X\x1b[0m`;

    expect(visibleLength(styled)).toBe(3);
    expect(stripAnsi(sliceVisible(styled, 2))).toBe(family);
    expect(clipVisible(styled, 2)).toBe(`\x1b[7m${family}\x1b[0m`);
    expect(clipVisible("A\uFE0F", 1)).toBe("A\uFE0F");
  });

  it("makes progress when a grapheme is wider than the requested wrap width", () => {
    expect(wrapVisibleLine("🇺🇸", 1)).toEqual(["🇺🇸"]);
    expect(wrapVisibleLine("\x1b[31m🇺🇸\x1b[0m", 1)).toEqual(["\x1b[31m🇺🇸\x1b[0m"]);
  });

  it("maps terminal columns to grapheme boundaries", () => {
    expect(offsetAtVisibleColumn("界x", 2)).toBe(1);
    expect(offsetAtVisibleColumn("e\u0301x", 1)).toBe(2);
  });

  it("renders tabs with the same fixed width used by input geometry", () => {
    expect(renderInputText("a\tb")).toBe("a    b");
  });
});
