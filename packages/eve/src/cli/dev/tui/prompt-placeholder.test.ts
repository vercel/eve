import { describe, expect, it } from "vitest";

import {
  PROMPT_PLACEHOLDER_MESSAGES,
  promptPlaceholder,
  promptPlaceholderCycleMs,
} from "./prompt-placeholder.js";

describe("promptPlaceholder", () => {
  it("holds each message for one cycle and rotates through the whole set", () => {
    expect(promptPlaceholder(0)).toBe(PROMPT_PLACEHOLDER_MESSAGES[0]);
    expect(promptPlaceholder(promptPlaceholderCycleMs - 1)).toBe(PROMPT_PLACEHOLDER_MESSAGES[0]);
    expect(promptPlaceholder(promptPlaceholderCycleMs)).toBe(PROMPT_PLACEHOLDER_MESSAGES[1]);
    expect(promptPlaceholder(promptPlaceholderCycleMs * PROMPT_PLACEHOLDER_MESSAGES.length)).toBe(
      PROMPT_PLACEHOLDER_MESSAGES[0],
    );
  });

  it("clamps a negative clock to the first message", () => {
    expect(promptPlaceholder(-100)).toBe(PROMPT_PLACEHOLDER_MESSAGES[0]);
  });
});
