import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { COMPACTION_PROMPT_ENVELOPE, createCompactionPrompt } from "#harness/compaction-prompt.js";
import { estimateTokens } from "#harness/token-estimate.js";

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

  it("uses a custom system prompt without changing the transcript envelope", () => {
    const result = createCompactionPrompt({
      messages: [{ content: "New evidence", role: "user" }],
      previousCheckpoint: undefined,
      systemPrompt: "Preserve every unresolved customer question.",
    });

    expect(result.system).toBe("Preserve every unresolved customer question.");
    expect(result.prompt).toContain("<previous-checkpoint>");
    expect(result.prompt).toContain("Conversation transcript:");
    expect(result.prompt).not.toContain("Make completed work explicit");
    expect(result.prompt).not.toContain("Preserve exact file paths");
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

  it("stubs content-output file parts instead of reproducing base64", () => {
    const base64 = "iVBORw0KGgo".repeat(500);
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: {
              type: "content",
              value: [
                { type: "text", text: "Rendered pixel for smoke-test:" },
                {
                  type: "file",
                  data: { type: "data", data: base64 },
                  filename: "pixel.png",
                  mediaType: "image/png",
                },
              ],
            },
            toolCallId: "call-1",
            toolName: "render_pixel",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const result = createCompactionPrompt({ messages, previousCheckpoint: undefined });

    expect(result.prompt).toContain(
      "Tool render_pixel returned Rendered pixel for smoke-test: " +
        "Attached file pixel.png (image/png)",
    );
    expect(result.prompt).not.toContain("iVBORw0KGgo");
  });

  it("stubs content-output file parts without filenames as attachments", () => {
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: {
              type: "content",
              value: [
                { type: "file", data: { type: "data", data: "aGVsbG8=" }, mediaType: "image/jpeg" },
              ],
            },
            toolCallId: "call-1",
            toolName: "screenshot",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const result = createCompactionPrompt({ messages, previousCheckpoint: undefined });

    expect(result.prompt).toContain(
      "Tool screenshot returned Attached file attachment (image/jpeg)",
    );
    expect(result.prompt).not.toContain("aGVsbG8=");
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

  it("includes the custom system prompt in the input budget", () => {
    const systemPrompt = "Preserve domain state. ".repeat(200);
    const result = createCompactionPrompt({
      messages: [
        { content: `${"old evidence ".repeat(800)}OLD_TAIL`, role: "user" },
        { content: `${"new evidence ".repeat(800)}NEW_TAIL`, role: "user" },
      ],
      previousCheckpoint: undefined,
      systemPrompt,
      inputBudgetTokens: 2_500,
    });

    expect(
      estimateTokens([
        { content: result.system, role: "system" },
        { content: result.prompt, role: "user" },
      ]),
    ).toBeLessThanOrEqual(2_500);
    expect(result.prompt).not.toContain("OLD_TAIL");
    expect(result.prompt).not.toContain("NEW_TAIL");
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
      inputBudgetTokens: 3_500,
      previousCheckpoint: undefined,
    });

    expect(result.prompt).not.toContain("OLDEST_TAIL_MARKER");
    expect(result.prompt).toContain("NEWEST_TAIL_MARKER");
  });
});
