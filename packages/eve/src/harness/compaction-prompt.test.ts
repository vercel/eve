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

  it("passes tool payloads to the summarizer raw so it can judge what matters", () => {
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
    // Raw clipped JSON, not a pre-digested object(…) skeleton: the checkpoint
    // model is the one deciding which parts of a payload matter.
    expect(result.prompt).toContain('Called search with {"query":"debug"}');
    expect(result.prompt).toContain('"alpha"');
    expect(result.prompt).toContain('"delta"');
  });

  it("clips oversized tool payloads instead of reproducing them", () => {
    const big = "match line ".repeat(1_000);
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "json", value: { content: big } },
            toolCallId: "call-1",
            toolName: "grep",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const result = createCompactionPrompt({ messages, previousCheckpoint: undefined });

    expect(result.prompt).toContain("Tool grep returned");
    expect(result.prompt).toContain("match line");
    expect(result.prompt).not.toContain(big);
    expect(result.prompt).toContain("…");
  });

  it("renders conversational text verbatim regardless of length", () => {
    // A delegated task message destroyed here is unrecoverable after the first
    // compaction, so user/assistant text must reach the summarizer whole.
    const taskTail = "CRITICAL_REQUIREMENT_AFTER_280_CHARACTERS";
    const task = `${"do the following work item. ".repeat(30)}${taskTail}`;

    const result = createCompactionPrompt({
      messages: [
        { content: task, role: "user" },
        { content: [{ text: task, type: "text" }], role: "assistant" },
      ],
      previousCheckpoint: undefined,
    });

    expect(result.prompt).toContain(taskTail);
    expect(result.prompt.split(taskTail)).toHaveLength(3);
  });

  it("degrades the oldest conversational text first under budget pressure", () => {
    const oldest = `${"oldest message padding. ".repeat(400)}OLDEST_TAIL_MARKER`;
    const newest = `${"newest message padding. ".repeat(400)}NEWEST_TAIL_MARKER`;

    const result = createCompactionPrompt({
      messages: [
        { content: oldest, role: "user" },
        { content: newest, role: "user" },
      ],
      // Fits one full entry plus a degraded one, but not both full.
      transcriptBudgetTokens: 3_500,
      previousCheckpoint: undefined,
    });

    expect(result.prompt).not.toContain("OLDEST_TAIL_MARKER");
    expect(result.prompt).toContain("NEWEST_TAIL_MARKER");
  });
});
