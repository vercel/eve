import { describe, expect, it } from "vitest";

import { parseBackgroundColorReply } from "./terminal-background.js";

describe("parseBackgroundColorReply", () => {
  it("parses the common 16-bit-per-channel reply", () => {
    expect(parseBackgroundColorReply("11;rgb:1e1e/2a2a/3b3b")).toEqual({
      r: 30,
      g: 42,
      b: 59,
    });
    expect(parseBackgroundColorReply("11;rgb:0000/0000/0000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseBackgroundColorReply("11;rgb:ffff/ffff/ffff")).toEqual({
      r: 255,
      g: 255,
      b: 255,
    });
  });

  it("scales each channel by its own hex width", () => {
    expect(parseBackgroundColorReply("11;rgb:ff/ff/ff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseBackgroundColorReply("11;rgb:f/f/f")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseBackgroundColorReply("11;rgb:8/80/800")).toEqual({ r: 136, g: 128, b: 128 });
  });

  it("rejects anything that is not an OSC 11 rgb reply", () => {
    expect(parseBackgroundColorReply("10;rgb:0000/0000/0000")).toBeUndefined();
    expect(parseBackgroundColorReply("11;?")).toBeUndefined();
    expect(parseBackgroundColorReply("11;rgb:zz/zz/zz")).toBeUndefined();
    expect(parseBackgroundColorReply("11;rgb:00000/0000/0000")).toBeUndefined();
    expect(parseBackgroundColorReply("")).toBeUndefined();
  });
});
