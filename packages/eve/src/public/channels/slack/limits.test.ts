import { describe, expect, it } from "vitest";

import {
  SLACK_BLOCK_KIT_PLAIN_TEXT_MAX_LENGTH,
  SLACK_MESSAGE_TEXT_MAX_LENGTH,
  SLACK_MODAL_TITLE_MAX_LENGTH,
  SLACK_SECTION_TEXT_MAX_LENGTH,
  SLACK_TYPING_STATUS_MAX_LENGTH,
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
