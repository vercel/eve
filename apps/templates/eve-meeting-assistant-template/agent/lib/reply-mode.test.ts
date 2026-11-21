import { describe, expect, it } from "vitest";

import { isChatOnly, readReplyMode, replyModeOf } from "./reply-mode.js";

describe("readReplyMode", () => {
  it("reads a tag and strips it", () => {
    expect(readReplyMode("[chat] Opened ENG-1")).toEqual({ mode: "chat", text: "Opened ENG-1" });
    expect(readReplyMode("\n[VOICE] Bob is.")).toEqual({ mode: "voice", text: "Bob is." });
  });

  it("waits while the text could still start a tag", () => {
    expect(readReplyMode("[ch")).toBeUndefined();
    expect(readReplyMode("")).toBeUndefined();
    expect(readReplyMode("\n ")).toBeUndefined();
  });

  it("rules a tag out once the text can't start one", () => {
    expect(readReplyMode("Bob is.")).toEqual({ mode: null, text: "Bob is." });
    expect(readReplyMode("[not a tag] hi")).toEqual({ mode: null, text: "[not a tag] hi" });
  });
});

describe("replyModeOf", () => {
  it("treats a finished partial tag as untagged text", () => {
    expect(replyModeOf("[ch")).toEqual({ mode: null, text: "[ch" });
  });
});

describe("isChatOnly", () => {
  it("is true only when every line came from the chat", () => {
    expect(isChatOnly(["Alice (in chat):\nopen a ticket"])).toBe(true);
    expect(isChatOnly(["Alice (in chat):\nhi", "Bob: eve, who's on it?"])).toBe(false);
    expect(isChatOnly([])).toBeUndefined();
  });
});
