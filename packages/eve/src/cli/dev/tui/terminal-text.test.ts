import { describe, expect, it } from "vitest";

import { stripAnsi, stripTerminalControls } from "./terminal-text.js";

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
