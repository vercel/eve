import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  COMPACTION_PROMPT_ENVELOPE,
  createCompactionPrompt,
  sliceUtf16Safe,
  TRANSCRIPT_PAYLOAD_LIMIT,
} from "#harness/compaction-prompt.js";

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

  it("does not split a UTF-16 surrogate pair when capping degraded conversational text", () => {
    // 📥 is U+1F4E5 — two UTF-16 units. Place its high surrogate exactly at
    // the degraded-text limit boundary (index 1999 of the 2000-unit cap).
    const content = "x".repeat(1999) + "📥" + " tail ".repeat(400);
    const { prompt } = createCompactionPrompt({
      messages: [{ role: "user", content }],
      previousCheckpoint: undefined,
      transcriptBudgetTokens: 100,
    });

    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(prompt)).toBe(false);
    expect(prompt).toBe(prompt.toWellFormed());
    expect(() => JSON.stringify({ prompt })).not.toThrow();
  });
});

describe("sliceUtf16Safe", () => {
  it("steps back when the cut falls on a high surrogate", () => {
    const value = "x".repeat(1999) + "📥" + "y";
    expect(value.charCodeAt(1999)).toBe(0xd83d);
    expect(value.charCodeAt(2000)).toBe(0xdce5);

    const sliced = sliceUtf16Safe(value, TRANSCRIPT_PAYLOAD_LIMIT);
    expect(sliced).toBe("x".repeat(1999));
    expect(sliced).toBe(sliced.toWellFormed());
  });

  it("keeps a complete astral character that fits inside the limit", () => {
    const value = "x".repeat(1998) + "📥" + "yyyy";
    const sliced = sliceUtf16Safe(value, TRANSCRIPT_PAYLOAD_LIMIT);
    expect(sliced).toBe("x".repeat(1998) + "📥");
    expect(sliced).toBe(sliced.toWellFormed());
  });
});
