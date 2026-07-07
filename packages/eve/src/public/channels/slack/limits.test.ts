import { describe, expect, it } from "vitest";

import {
  SLACK_BLOCK_KIT_PLAIN_TEXT_MAX_LENGTH,
  SLACK_MESSAGE_TEXT_MAX_LENGTH,
  SLACK_MODAL_TITLE_MAX_LENGTH,
  SLACK_SECTION_TEXT_MAX_LENGTH,
  SLACK_TYPING_STATUS_MAX_LENGTH,
  splitForSlackMessage,
  truncateMessageText,
  truncateModalTitle,
  truncatePlainText,
  truncateSectionText,
  truncateTypingStatus,
} from "#public/channels/slack/limits.js";

describe("truncateTypingStatus", () => {
  it("returns short strings unchanged", () => {
    expect(truncateTypingStatus("Working...")).toBe("Working...");
  });

  it("collapses runs of whitespace and trims surrounding space", () => {
    expect(truncateTypingStatus("   Running   foo,   bar  ")).toBe("Running foo, bar");
  });

  it("strips Markdown formatting that assistant status renders literally", () => {
    expect(truncateTypingStatus("**Considering turbo tasks**")).toBe("Considering turbo tasks");
    expect(truncateTypingStatus("Running `turbo` for [eve](https://github.com/vercel/eve)")).toBe(
      "Running turbo for eve",
    );
  });

  it("caps at the typing-status limit with a trailing ellipsis", () => {
    const long = "a".repeat(SLACK_TYPING_STATUS_MAX_LENGTH + 20);
    const result = truncateTypingStatus(long);
    expect(result.length).toBeLessThanOrEqual(SLACK_TYPING_STATUS_MAX_LENGTH);
    expect(result.endsWith("...")).toBe(true);
  });

  it("does not append ellipsis when the input is exactly at the limit", () => {
    const exact = "a".repeat(SLACK_TYPING_STATUS_MAX_LENGTH);
    expect(truncateTypingStatus(exact)).toBe(exact);
  });

  it("trims trailing whitespace before appending the ellipsis", () => {
    const padded = `${"a".repeat(SLACK_TYPING_STATUS_MAX_LENGTH - 5)}     trailing`;
    const result = truncateTypingStatus(padded);
    expect(result.endsWith(" ...")).toBe(false);
    expect(result.endsWith("...")).toBe(true);
  });
});

describe("truncatePlainText", () => {
  it("returns short strings unchanged", () => {
    expect(truncatePlainText("Approve")).toBe("Approve");
  });

  it("caps long strings at the Block Kit plain_text limit", () => {
    const long = "x".repeat(SLACK_BLOCK_KIT_PLAIN_TEXT_MAX_LENGTH + 50);
    const result = truncatePlainText(long);
    expect(result.length).toBeLessThanOrEqual(SLACK_BLOCK_KIT_PLAIN_TEXT_MAX_LENGTH);
    expect(result.endsWith("...")).toBe(true);
  });

  it("passes undefined through unchanged for optional descriptions", () => {
    expect(truncatePlainText(undefined)).toBeUndefined();
  });
});

describe("truncateModalTitle", () => {
  it("returns short strings unchanged", () => {
    expect(truncateModalTitle("Your answer")).toBe("Your answer");
  });

  it("caps at the modal-title limit with a trailing ellipsis", () => {
    const long = "y".repeat(SLACK_MODAL_TITLE_MAX_LENGTH + 10);
    const result = truncateModalTitle(long);
    expect(result.length).toBeLessThanOrEqual(SLACK_MODAL_TITLE_MAX_LENGTH);
    expect(result.endsWith("...")).toBe(true);
  });
});

describe("truncateSectionText", () => {
  it("returns short strings unchanged", () => {
    expect(truncateSectionText("Approve deploy?")).toBe("Approve deploy?");
  });

  it("caps long strings at the section-text limit with a trailing ellipsis", () => {
    const long = "p".repeat(SLACK_SECTION_TEXT_MAX_LENGTH + 500);
    const result = truncateSectionText(long);
    expect(result.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX_LENGTH);
    expect(result.endsWith("...")).toBe(true);
  });

  it("does not append ellipsis when the input is exactly at the limit", () => {
    const exact = "p".repeat(SLACK_SECTION_TEXT_MAX_LENGTH);
    expect(truncateSectionText(exact)).toBe(exact);
  });
});

describe("truncateMessageText", () => {
  it("returns short strings unchanged", () => {
    expect(truncateMessageText("Pick one")).toBe("Pick one");
  });

  it("caps long strings at the message-text limit with a trailing ellipsis", () => {
    const long = "m".repeat(SLACK_MESSAGE_TEXT_MAX_LENGTH + 1000);
    const result = truncateMessageText(long);
    expect(result.length).toBeLessThanOrEqual(SLACK_MESSAGE_TEXT_MAX_LENGTH);
    expect(result.endsWith("...")).toBe(true);
  });
});

describe("splitForSlackMessage", () => {
  it("returns the text unchanged when it already fits", () => {
    expect(splitForSlackMessage("hello world", 40)).toEqual(["hello world"]);
    expect(splitForSlackMessage("a".repeat(SLACK_MESSAGE_TEXT_MAX_LENGTH))).toHaveLength(1);
  });

  it("splits over-limit text into chunks that each fit and are non-empty", () => {
    const long = "a".repeat(SLACK_MESSAGE_TEXT_MAX_LENGTH * 2 + 500);
    const chunks = splitForSlackMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_MESSAGE_TEXT_MAX_LENGTH);
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("prefers paragraph boundaries", () => {
    const para = "p".repeat(60);
    expect(splitForSlackMessage([para, para].join("\n\n"), 100)).toEqual([para, para]);
  });

  it("falls back to word boundaries when there are no newlines", () => {
    const chunks = splitForSlackMessage("word ".repeat(40).trim(), 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
      expect(chunk.startsWith(" ")).toBe(false);
      expect(chunk.endsWith(" ")).toBe(false);
    }
  });

  it("hard-cuts a single run with no usable boundary", () => {
    expect(splitForSlackMessage("z".repeat(45), 20)).toEqual(["z".repeat(20), "z".repeat(20), "z".repeat(5)]);
  });
});
