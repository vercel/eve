import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { COMPACTION_PROMPT_ENVELOPE, createCompactionPrompt } from "#harness/compaction-prompt.js";

describe("createCompactionPrompt", () => {
  it("preserves the previous checkpoint without applying transcript truncation", () => {
    const markerAfterTextLimit = "CRITICAL_STATE_AFTER_280_CHARACTERS";
    const previousCheckpoint = `${"completed work ".repeat(24)}${markerAfterTextLimit}`;

    const result = createCompactionPrompt({
      messages: [{ content: "New evidence", role: "user" }],
      previousCheckpoint,
    });

    expect(result.system).toBe(COMPACTION_PROMPT_ENVELOPE.system);
    expect(result.prompt).toContain(`<previous-checkpoint>\n${previousCheckpoint}`);
    expect(result.prompt).toContain(markerAfterTextLimit);
  });

  it("summarizes structured tool messages without dumping raw JSON", () => {
    const messages: ModelMessage[] = [
      {
        content: [
          {
            input: { query: "debug" },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "json",
              value: ["alpha", "beta", "gamma", "delta"],
            },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const result = createCompactionPrompt({ messages, previousCheckpoint: undefined });

    expect(result.prompt).toContain("Conversation transcript:");
    expect(result.prompt).toContain("### assistant");
    expect(result.prompt).toContain("Called search with object(query=debug)");
    expect(result.prompt).toContain(
      "Tool search returned object(type=json, value=array(4: alpha, beta, gamma, …))",
    );
    expect(result.prompt).not.toContain('{"query"');
    expect(result.prompt).not.toContain('{"items"');
  });
});
