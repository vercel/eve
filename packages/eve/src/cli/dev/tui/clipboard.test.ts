import { describe, expect, it } from "vitest";

import { clipboardCommand, clipboardSequence } from "#cli/dev/tui/clipboard.js";

describe("clipboardSequence", () => {
  it("encodes the text as base64 in an OSC 52 write", () => {
    expect(clipboardSequence("hello", {})).toBe(
      `\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`,
    );
  });

  it("wraps the sequence for tmux and screen passthrough", () => {
    const inner = clipboardSequence("hi", {});
    expect(clipboardSequence("hi", { TMUX: "/tmp/tmux-1000/default" })).toBe(
      `\x1bPtmux;\x1b${inner}\x1b\\`,
    );
    expect(clipboardSequence("hi", { STY: "1234.pts-0" })).toBe(`\x1bPtmux;\x1b${inner}\x1b\\`);
  });
});

describe("clipboardCommand", () => {
  it("picks the platform clipboard tool", () => {
    expect(clipboardCommand("darwin", {})).toEqual(["pbcopy"]);
    expect(clipboardCommand("linux", {})).toEqual(["xclip", "-selection", "clipboard"]);
    expect(clipboardCommand("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual(["wl-copy"]);
    expect(clipboardCommand("win32", {})).toEqual(["clip"]);
    expect(clipboardCommand("freebsd", {})).toBeUndefined();
  });
});
