import { describe, expect, it } from "vitest";

import { clipVisible, stripAnsi, stripTerminalControls, visibleLength } from "./terminal-text.js";

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

describe("clipVisible", () => {
  it("closes styled text when truncation removes the original close", () => {
    const clipped = clipVisible("\x1b[7m\x1b[34malpha\x1b[39m\x1b[27m", 3);

    expect(clipped).toBe("\x1b[7m\x1b[34malp\x1b[0m");
    expect(visibleLength(clipped)).toBe(3);
  });

  it("does not append a reset when the text fits", () => {
    expect(clipVisible("\x1b[34malpha\x1b[39m", 5)).toBe("\x1b[34malpha\x1b[39m");
  });
});
