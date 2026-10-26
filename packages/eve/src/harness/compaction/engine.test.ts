import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { COMPACTION_PROMPT_ENVELOPE } from "#harness/compaction/prompt.js";
import { compactMessages, getInputTokenCount, shouldCompact } from "#harness/compaction/engine.js";
import { createFrameworkUserMessage } from "#harness/messages.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { CompactionConfig } from "#harness/types.js";
import { encodeSandboxRef } from "#internal/attachments/sandbox-refs.js";
import { pngBytes } from "#internal/testing/media-fixtures.js";

const config: CompactionConfig = {
  recentWindowSize: 2,
  threshold: 100,
};

function toolFileMessage(data: unknown, mediaType = "image/png"): ModelMessage {
  return {
    content: [
      {
        output: {
          type: "content",
          value: [{ data, mediaType, type: "file" }],
        } as never,
        toolCallId: "call-image",
        toolName: "render",
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}

describe("estimateTokens", () => {
  it("estimates based on serialized character length", () => {
    const messages: ModelMessage[] = [{ content: "a".repeat(400), role: "user" }];
    // JSON.stringify wraps the payload with struct chars; the estimate is
    // serialized-length / 4. The exact value matters less than the rough
    // relationship to raw content length.
    expect(estimateTokens(messages)).toBeGreaterThanOrEqual(100);
    expect(estimateTokens(messages)).toBeLessThan(120);
  });

  it("treats structured payloads as denser than plain text of similar size", () => {
    const text = "a".repeat(400);
    const plain: ModelMessage[] = [{ content: text, role: "user" }];
    const structured: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "json", value: { value: text } },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    expect(estimateTokens(structured)).toBeGreaterThan(estimateTokens(plain));
  });

  it("counts structured tool-result payloads when they grow", () => {
    const small: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "json", value: { value: "a" } },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];
    const large: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "json", value: { value: "a".repeat(400) } },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    expect(estimateTokens(large)).toBeGreaterThan(estimateTokens(small));
  });

  it("counts all content parts including reasoning", () => {
    // The simplified estimator uses JSON.stringify(messages).length / 4 with
    // no type-specific skipping. Reasoning contributes to the estimate like
    // any other payload — this is intentional: the true token count comes
    // back from the model each step via `lastKnownInputTokens`, so the
    // heuristic only needs to roughly track size.
    const base: ModelMessage[] = [
      {
        content: [
          {
            input: { query: "debug logs" },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
    ];
    const withReasoning: ModelMessage[] = [
      ...base,
      {
        content: [
          {
            text: "chain of thought",
            type: "reasoning",
          },
        ],
        role: "assistant",
      },
    ];

    expect(estimateTokens(base)).toBeGreaterThan(0);
    expect(estimateTokens(withReasoning)).toBeGreaterThan(estimateTokens(base));
  });

  it("counts an inline image by its pixel patches instead of its base64 length", () => {
    const base64 = pngBytes(1000, 1000, 300_000).toString("base64");
    const estimate = estimateTokens([toolFileMessage({ data: base64, type: "data" })]);

    expect(estimate).toBeGreaterThan(1296);
    expect(estimate).toBeLessThan(1296 + 100);
  });

  it("counts a staged image from its ref metadata without the bytes", () => {
    const ref = encodeSandboxRef({
      height: 1080,
      mediaType: "image/png",
      path: "/workspace/.eve/attachments/abc/screen.png",
      size: 2_000_000,
      width: 1920,
    });
    const estimate = estimateTokens([toolFileMessage({ type: "url", url: ref })]);

    expect(estimate).toBeGreaterThan(2691);
    expect(estimate).toBeLessThan(2691 + 100);
  });

  it("counts an inbound attachment that renders as a path reference as text", () => {
    const message: ModelMessage = {
      content: [
        {
          data: encodeSandboxRef({
            mediaType: "text/csv",
            path: "/workspace/.eve/attachments/abc/report.csv",
            size: 3_000_000,
          }),
          mediaType: "text/csv",
          type: "file",
        },
      ],
      role: "user",
    };

    expect(estimateTokens([message])).toBeLessThan(100);
  });
});

describe("getInputTokenCount", () => {
  // #3799: two page scans returned by a vision tool counted as ~160k tokens
  // of base64 text and forced compaction against a 43,895-token prompt.
  it("does not count tool-result image bytes as text before provider usage arrives", () => {
    const page = pngBytes(1000, 1000, 240_000).toString("base64");
    const prompt: ModelMessage[] = [{ content: "Read both scanned pages.", role: "user" }];
    const messages = [
      ...prompt,
      toolFileMessage({ data: page, type: "data" }),
      toolFileMessage({ data: page, type: "data" }),
    ];

    const result = getInputTokenCount(messages, {
      lastKnownInputTokens: 43_895,
      lastKnownPromptMessageCount: prompt.length,
      recentWindowSize: 2,
      threshold: 200_000,
    });

    expect(result).toBeGreaterThan(43_895 + 2 * 1296);
    expect(result).toBeLessThan(43_895 + 2 * 1296 + 200);
  });

  it("prefers the last known exact token count when available", () => {
    const messages: ModelMessage[] = [{ content: "a".repeat(400), role: "user" }];

    const result = getInputTokenCount(messages, {
      ...config,
      lastKnownInputTokens: 42,
      lastKnownPromptMessageCount: 1,
    });
    // No appended messages: the exact prior count is the whole count.
    expect(result).toBe(42);
  });

  it("adds appended-message estimates on top of the last exact prompt count", () => {
    const messages: ModelMessage[] = [
      { content: "a".repeat(400), role: "user" },
      { content: "b".repeat(80), role: "assistant" },
    ];

    const result = getInputTokenCount(messages, {
      ...config,
      lastKnownInputTokens: 42,
      lastKnownPromptMessageCount: 1,
    });
    // prior (42) + rough estimate of the one appended assistant message.
    // The assistant message is ~80 content chars plus JSON struct overhead.
    expect(result).toBeGreaterThan(42 + 20);
    expect(result).toBeLessThan(42 + 40);
  });
  it("counts only positive envelope growth above the previous provider usage", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "unchanged" }];
    const measured = {
      ...config,
      lastKnownInputTokens: 8_000,
      lastKnownPromptMessageCount: 1,
    };
    const stable = getInputTokenCount(messages, measured, 3_000, 3_000);
    expect(stable).toBe(8_000);
    expect(getInputTokenCount(messages, measured, 5_000, 3_000)).toBe(stable + 2_000);
    expect(getInputTokenCount(messages, measured, 1_000, 3_000)).toBe(stable);
  });

  it("includes the full envelope when provider usage cannot describe the current history", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "replacement" }];
    expect(getInputTokenCount(messages, config, 3_000)).toBe(estimateTokens(messages) + 3_000);
    expect(
      getInputTokenCount(
        messages,
        {
          ...config,
          lastKnownInputTokens: 8_000,
          lastKnownPromptMessageCount: 5,
        },
        3_000,
      ),
    ).toBe(estimateTokens(messages) + 3_000);
  });
});

describe("shouldCompact", () => {
  it("returns false when under threshold", () => {
    const messages: ModelMessage[] = [{ content: "short", role: "user" }];
    expect(shouldCompact(messages, { ...config, threshold: 1_000 })).toBe(false);
  });

  it("returns true when over threshold", () => {
    const messages: ModelMessage[] = [{ content: "a".repeat(500), role: "user" }];
    expect(shouldCompact(messages, config)).toBe(true);
  });

  it("uses the fixed prompt envelope in threshold accounting", () => {
    const messages: ModelMessage[] = [{ content: "Continue the investigation.", role: "user" }];
    const compaction: CompactionConfig = {
      lastKnownInputTokens: 200,
      lastKnownPromptMessageCount: messages.length,
      recentWindowSize: 2,
      threshold: 1_000,
    };
    const activeInputTokens = getInputTokenCount(messages, compaction);
    const promptEnvelopeTokens = estimateTokens([
      { content: COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
      createFrameworkUserMessage("context.compaction", COMPACTION_PROMPT_ENVELOPE.prompt),
    ] satisfies ModelMessage[]);

    expect(
      shouldCompact(messages, {
        ...compaction,
        threshold: activeInputTokens + promptEnvelopeTokens,
      }),
    ).toBe(false);
    expect(
      shouldCompact(messages, {
        ...compaction,
        threshold: activeInputTokens + promptEnvelopeTokens - 1,
      }),
    ).toBe(true);
  });

  it("does not compact an empty history based on prompt overhead alone", () => {
    expect(shouldCompact([], { ...config, threshold: 0 })).toBe(false);
  });

  // #4292: a 40,000-character Chinese tool result costs about 30k o200k and
  // 40k cl100k tokens, but serialized length / 4 counted it as about 10k, so a
  // measured 165k prompt reached the 200k window without compacting.
  it("compacts when a large CJK tool result pushes a measured prompt over the threshold", () => {
    const prompt: ModelMessage[] = [
      { content: "Summarize the attached Chinese report.", role: "user" },
    ];
    const report: ModelMessage = {
      content: [
        {
          output: {
            type: "text",
            value: "大型语言模型在长上下文任务中的表现取决于其对检索证据的整合能力。".repeat(1_250),
          },
          toolCallId: "call-1",
          toolName: "read_document",
          type: "tool-result",
        },
      ],
      role: "tool",
    };

    expect(
      shouldCompact([...prompt, report], {
        lastKnownInputTokens: 165_000,
        lastKnownPromptMessageCount: prompt.length,
        recentWindowSize: 4,
        threshold: 180_000,
      }),
    ).toBe(true);
  });
});

// --- compactMessages ---------------------------------------------------
//
// compactMessages escalates through heuristics before summarizing, and which
// strategy a test hits is pure threshold arithmetic:
//
// - The tool-result cap heuristic is accepted only when the capped history
//   PLUS the fixed compaction prompt envelope fits the threshold.
//   `HEURISTICS_FORBIDDEN` leaves only a little room above the envelope, and
//   `compact` prepends `OLD_BULK` to a history at that threshold, so no
//   heuristic can be accepted and the summarization fallback always runs.
// - `ROOMY` accepts capping whenever the history's bulk is tool output.
//
// Every result is checked against `expectWellFormedCompaction`: no orphaned
// tool_result, never trailing on an assistant message, and — unless the
// window was exhausted — within the threshold on shouldCompact's own ruler,
// so the result cannot immediately re-trigger compaction.

const ENVELOPE_TOKENS = estimateTokens([
  { content: COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
  createFrameworkUserMessage("context.compaction", COMPACTION_PROMPT_ENVELOPE.prompt),
] satisfies ModelMessage[]);
const HEURISTICS_FORBIDDEN = Math.floor(ENVELOPE_TOKENS) + 200;
const OLD_BULK: ModelMessage[] = [
  { content: "background ".repeat(150), role: "user" },
  { content: "noted", role: "assistant" },
];
const ROOMY = 100_000;

const CHECKPOINT_MARKER = "Summary of our conversation so far:";

function user(text: string): ModelMessage {
  return { content: text, role: "user" };
}

function compactionMarker(text: string): ModelMessage {
  return createFrameworkUserMessage("context.compaction", text);
}

function assistant(text: string): ModelMessage {
  return { content: text, role: "assistant" };
}

/** An assistant tool-call message and its paired tool-result message. */
function toolExchange(input: {
  readonly callId: string;
  readonly payloadChars: number;
  readonly prose?: string;
}): [ModelMessage, ModelMessage] {
  return [
    {
      content: [
        ...(input.prose === undefined ? [] : [{ text: input.prose, type: "text" as const }]),
        {
          input: { pattern: "todo" },
          toolCallId: input.callId,
          toolName: "grep",
          type: "tool-call" as const,
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "json" as const, value: { content: "x".repeat(input.payloadChars) } },
          toolCallId: input.callId,
          toolName: "grep",
          type: "tool-result" as const,
        },
      ],
      role: "tool",
    },
  ];
}

function toolResultExchange(
  output: { type: "json"; value: { content: string } } | { type: "text"; value: string },
): [ModelMessage, ModelMessage] {
  return [
    {
      content: [{ input: {}, toolCallId: "call-0", toolName: "grep", type: "tool-call" }],
      role: "assistant",
    },
    {
      content: [{ output, toolCallId: "call-0", toolName: "grep", type: "tool-result" }],
      role: "tool",
    },
  ];
}

function toolResultValue(message: ModelMessage | undefined): string {
  const part = Array.isArray(message?.content) ? message.content[0] : undefined;
  const output = part?.type === "tool-result" ? part.output : undefined;
  return output?.type === "text" ? output.value : "";
}

function isCheckpointHead(messages: readonly ModelMessage[]): boolean {
  return messages[0]?.content === CHECKPOINT_MARKER;
}

function checkpointHead(text: string): ModelMessage[] {
  return [compactionMarker(CHECKPOINT_MARKER), assistant(text)];
}

function expectWellFormedCompaction(result: ModelMessage[], threshold: number): void {
  const seenCallIds = new Set<string>();
  for (const message of result) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") seenCallIds.add(part.toolCallId);
      if (part.type === "tool-result") {
        expect(seenCallIds.has(part.toolCallId), "orphaned tool_result").toBe(true);
      }
    }
  }

  expect(result.at(-1)?.role, "history must not trail on assistant content").not.toBe("assistant");

  if (result.length > 2) {
    expect(estimateTokens(result)).toBeLessThanOrEqual(threshold);
  }
}

async function compact(
  messages: ModelMessage[],
  overrides: Partial<CompactionConfig> & { readonly summary?: string } = {},
): Promise<{ result: ModelMessage[]; summarizer: ReturnType<typeof summarizeWith> }> {
  const summarizer = summarizeWith(overrides.summary ?? "checkpoint text");

  const compactionConfig: CompactionConfig = {
    lastKnownInputTokens: overrides.lastKnownInputTokens,
    lastKnownPromptMessageCount: overrides.lastKnownPromptMessageCount,
    recentWindowSize: overrides.recentWindowSize ?? 4,
    threshold: overrides.threshold ?? ROOMY,
  };
  const history =
    compactionConfig.threshold === HEURISTICS_FORBIDDEN && !isCheckpointHead(messages)
      ? [...OLD_BULK, ...messages]
      : messages;
  const result = await compactMessages(history, compactionConfig, summarizer);

  expectWellFormedCompaction(result, compactionConfig.threshold);
  return { result, summarizer };
}

function summarizeWith(summary: string) {
  return vi.fn(
    async (_prompt: { readonly messages: ModelMessage[]; readonly system: string }) => summary,
  );
}

describe("compactMessages: tool-result cap heuristic", () => {
  it.each([false, true])(
    "summarizes provider-measured pressure when capping is insufficient (tool output: %s)",
    async (withToolOutput) => {
      const messages = [
        ...checkpointHead("Previous investigation checkpoint."),
        user("Dense multilingual context ".repeat(30)),
        ...(withToolOutput
          ? toolExchange({ callId: "call-0", payloadChars: 4_000 })
          : [assistant("Evidence recorded.")]),
        user("Continue the investigation."),
      ];
      const measuredConfig = {
        lastKnownInputTokens: 60_000,
        lastKnownPromptMessageCount: messages.length - 1,
        recentWindowSize: 1,
        threshold: 20_000,
      };
      expect(shouldCompact(messages, measuredConfig)).toBe(true);
      expect(estimateTokens(messages) + ENVELOPE_TOKENS).toBeLessThan(measuredConfig.threshold);

      const { result, summarizer } = await compact(messages, measuredConfig);

      expect(summarizer).toHaveBeenCalledOnce();
      expect(result[1]).toEqual(assistant("checkpoint text"));
      expect(result.at(-1)).toEqual(messages.at(-1));
      expect(result).toHaveLength(3);
      expect(shouldCompact(result, { recentWindowSize: 1, threshold: 20_000 })).toBe(false);
    },
  );

  it("accepts capping that frees enough space against the measured input count", async () => {
    const messages = [
      user("Investigate."),
      ...toolExchange({ callId: "large", payloadChars: 100_000 }),
      user("Continue."),
    ];
    const measuredConfig = {
      lastKnownInputTokens: 30_000,
      lastKnownPromptMessageCount: messages.length,
      recentWindowSize: 1,
      threshold: 20_000,
    };
    expect(shouldCompact(messages, measuredConfig)).toBe(true);
    const { result, summarizer } = await compact(messages, measuredConfig);
    expect(summarizer).not.toHaveBeenCalled();
    expect(result).toHaveLength(messages.length);
    expect(JSON.stringify(result)).toContain("Truncated by eve");
  });

  it.each([undefined, -1, 100])(
    "ignores unusable prompt counts (%s) when evaluating capping",
    async (lastKnownPromptMessageCount) => {
      const messages = [
        user("Investigate."),
        ...toolExchange({ callId: "large", payloadChars: 4_000 }),
        user("Continue."),
      ];
      const { summarizer } = await compact(messages, {
        lastKnownInputTokens: 30_000,
        lastKnownPromptMessageCount,
        recentWindowSize: 1,
        threshold: 20_000,
      });
      expect(summarizer).not.toHaveBeenCalled();
    },
  );
  it("credits removed history against the provider count of the measured messages", async () => {
    const summarize = summarizeWith("summary");
    const [call, resultMsg] = toolExchange({ callId: "large", payloadChars: 40_000 });
    const messages = [user("investigate"), call, resultMsg, user("continue")];
    const result = await compactMessages(
      messages,
      {
        lastKnownInputTokens: 15_000,
        lastKnownPromptMessageCount: messages.length,
        recentWindowSize: 1,
        threshold: 10_000,
      },
      summarize,
    );
    expect(summarize).not.toHaveBeenCalled();
    expect(estimateTokens(result)).toBeLessThan(2_000);
    expect(result.map((entry) => entry.role)).toEqual(messages.map((entry) => entry.role));
  });

  it("summarizes when a no-op cannot satisfy the provider count of the measured messages", async () => {
    const summarize = summarizeWith("summary");
    const messages = [user("earlier ".repeat(1_500)), assistant("reply"), user("continue")];
    const history = estimateTokens(messages);
    await compactMessages(
      messages,
      {
        lastKnownInputTokens: history * 2,
        lastKnownPromptMessageCount: messages.length,
        recentWindowSize: 0,
        threshold: Math.floor(history * 1.5),
      },
      summarize,
    );
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("caps oversized older tool results in place without calling the summarizer", async () => {
    const [call, resultMsg] = toolExchange({
      callId: "call-0",
      payloadChars: 4_000,
      prose: "Searching first.",
    });
    const messages = [user("investigate the bug"), call, resultMsg, user("what did you find?")];

    const { result, summarizer } = await compact(messages, { recentWindowSize: 1 });

    expect(summarizer).not.toHaveBeenCalled();
    // Structure survives untouched: the assistant message keeps its prose and
    // its tool-call part, and the result stays a tool message.
    expect(result[0]).toEqual(user("investigate the bug"));
    expect(result[1]).toBe(call);
    const cappedPart = Array.isArray(result[2]?.content) ? result[2].content[0] : undefined;
    expect(cappedPart?.type).toBe("tool-result");
    const output = cappedPart?.type === "tool-result" ? cappedPart.output : undefined;
    const value =
      typeof output === "object" && output !== null && "value" in output
        ? String(output.value)
        : "";
    // Annotation leads; a real content prefix follows; the 4k bulk is gone.
    expect(value).toContain("Truncated by eve");
    expect(value).toContain("xxx");
    expect(value.length).toBeLessThan(2_400);
    expect(result.at(-1)).toEqual(user("what did you find?"));
    // The capped result cannot immediately re-trigger compaction.
    expect(shouldCompact(result, { recentWindowSize: 1, threshold: ROOMY })).toBe(false);
  });

  it("leaves an already-capped tool result unchanged on a later compaction", async () => {
    const annotations = (message: ModelMessage | undefined) =>
      JSON.stringify(message).split("Truncated by eve").length - 1;
    const messages = [
      user("investigate the bug"),
      ...toolExchange({ callId: "call-0", payloadChars: 4_000 }),
      user("keep going"),
    ];
    const { result: first } = await compact(messages, { recentWindowSize: 1 });
    const capped = first[2];
    expect(annotations(capped)).toBe(1);

    const { result: second, summarizer } = await compact(
      [
        ...first,
        ...toolExchange({ callId: "call-1", payloadChars: 4_000 }),
        user("what did you find?"),
      ],
      { recentWindowSize: 1 },
    );

    expect(summarizer).not.toHaveBeenCalled();
    expect(annotations(second[2])).toBe(1);
    expect(second[2]).toEqual(capped);
  });

  it("does not split a UTF-16 surrogate pair at either cut when capping tool results", async () => {
    // Astral characters across the whole cut window: both the head and the
    // tail cut fall inside surrogate pairs at one of the two offsets.
    for (const offset of [0, 1]) {
      const content = `${"x".repeat(offset)}${"📥".repeat(2_000)}`;
      const { result } = await compact(
        [
          user("investigate"),
          ...toolResultExchange({ type: "json", value: { content } }),
          user("next"),
        ],
        { recentWindowSize: 1 },
      );
      const value = toolResultValue(result[2]);
      expect(value.startsWith("[Truncated by eve")).toBe(true);
      expect(value.length).toBeLessThanOrEqual(2_000);
      expect(value).toBe(value.toWellFormed());
      expect(value).toContain("chars omitted");
      expect(value.endsWith('📥"}}')).toBe(true);
    }
  });

  it("keeps the failure and exit code of a large bash result when capping", async () => {
    const stdout = `${"✓ passing test\n".repeat(300)}FAIL src/auth.test.ts\nTest Files  1 failed`;
    const call: ModelMessage = {
      content: [{ input: {}, toolCallId: "call-0", toolName: "bash", type: "tool-call" }],
      role: "assistant",
    };
    const resultMsg: ModelMessage = {
      content: [
        {
          output: {
            type: "json",
            value: { stderr: "", stdout, truncated: false, exitCode: 1, status: "completed" },
          },
          toolCallId: "call-0",
          toolName: "bash",
          type: "tool-result",
        },
      ],
      role: "tool",
    };
    const messages = [user("run the tests"), call, resultMsg, user("what failed?")];

    const { result, summarizer } = await compact(messages, { recentWindowSize: 1 });

    expect(summarizer).not.toHaveBeenCalled();
    const cappedPart = Array.isArray(result[2]?.content) ? result[2].content[0] : undefined;
    const output = cappedPart?.type === "tool-result" ? cappedPart.output : undefined;
    const value =
      typeof output === "object" && output !== null && "value" in output
        ? String(output.value)
        : "";
    expect(value.startsWith("[Truncated by eve")).toBe(true);
    expect(value).toContain("✓ passing test");
    expect(value).toContain("chars omitted");
    expect(value).toContain(String.raw`FAIL src/auth.test.ts\nTest Files  1 failed`);
    expect(value).toContain('"exitCode":1,"status":"completed"}');
  });

  it.each([
    ["plain JSON", { type: "json" as const, value: { content: "x".repeat(4_000) } }],
    ["escape-heavy JSON", { type: "json" as const, value: { content: 'a"b\\c\n\t'.repeat(800) } }],
    ["astral characters", { type: "json" as const, value: { content: "📥".repeat(2_000) } }],
    ["text", { type: "text" as const, value: `line "one"\n${"y".repeat(4_000)}` }],
  ])("returns a capped %s result unchanged on every later compaction", async (_name, output) => {
    let history: ModelMessage[] = [
      user("investigate"),
      ...toolResultExchange(output),
      user("next"),
    ];
    const { result: first } = await compact(history, { recentWindowSize: 1 });
    const capped = first[2];
    const cappedValue = toolResultValue(capped);
    expect(cappedValue.startsWith("[Truncated by eve")).toBe(true);
    expect(cappedValue.length).toBeLessThanOrEqual(2_000);

    history = first;
    for (let round = 0; round < 3; round += 1) {
      const { result, summarizer } = await compact(history, { recentWindowSize: 1 });
      expect(summarizer).not.toHaveBeenCalled();
      expect(result[2]).toBe(capped);
      history = result;
    }
  });

  it.each([
    ["plain JSON", { content: `KEPT-HEAD-7781${"z".repeat(4_000)}KEPT-TAIL-7781` }],
    [
      "escape-heavy JSON",
      { content: `KEPT-HEAD-7781${"z".repeat(4_000)}${'q"\\'.repeat(300)}KEPT-TAIL-7781` },
    ],
  ])(
    "keeps the whole capped %s content when a later compaction summarizes",
    async (_name, value) => {
      const history: ModelMessage[] = [
        user("investigate"),
        ...toolResultExchange({ type: "json", value }),
        user("next"),
      ];
      const { result: first } = await compact(history, { recentWindowSize: 1 });
      const cappedValue = toolResultValue(first[2]);
      expect(cappedValue).toContain("KEPT-HEAD-7781");
      expect(cappedValue.split("chars omitted").length - 1).toBe(1);
      expect(cappedValue.endsWith('KEPT-TAIL-7781"}}')).toBe(true);

      const summarize = summarizeWith("forced checkpoint");
      await compactMessages(first, { recentWindowSize: 1, threshold: ROOMY }, summarize, true);

      const transcript = String(summarize.mock.calls[0]?.[0]?.messages?.[0]?.content);
      expect(transcript).toContain(cappedValue.replace(/\s+/g, " ").trim());
      expect(transcript.split("Truncated by eve").length - 1).toBe(1);
    },
  );

  it("stubs content-output file parts instead of truncating into their payloads", async () => {
    const base64 = "iVBORw0KGgo".repeat(500);
    const messages: ModelMessage[] = [
      user("render the chart"),
      {
        content: [{ input: {}, toolCallId: "call-0", toolName: "render_chart", type: "tool-call" }],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "content",
              value: [
                { text: "Chart summary: revenue up.", type: "text" },
                {
                  data: { data: base64, type: "data" },
                  filename: "chart.png",
                  mediaType: "image/png",
                  type: "file",
                },
              ],
            },
            toolCallId: "call-0",
            toolName: "render_chart",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      user("what does it show?"),
    ];

    const { result, summarizer } = await compact(messages, { recentWindowSize: 1 });

    expect(summarizer).not.toHaveBeenCalled();
    const cappedPart = Array.isArray(result[2]?.content) ? result[2].content[0] : undefined;
    expect(cappedPart?.type).toBe("tool-result");
    const output = cappedPart?.type === "tool-result" ? cappedPart.output : undefined;
    // Stubbing the file part is enough to fit: the output stays a structured
    // content output, the sibling text survives whole, and no payload bytes
    // (or truncation annotation) remain.
    expect(output).toEqual({
      type: "content",
      value: [
        { text: "Chart summary: revenue up.", type: "text" },
        { text: "Attached file chart.png (image/png)", type: "text" },
      ],
    });
  });

  it("stubs a staged tool file with its sandbox path so the agent can reopen it", async () => {
    const path = "/workspace/.eve/attachments/0123456789abcdef/chart.png";
    const messages: ModelMessage[] = [
      user("render the chart"),
      {
        content: [{ input: {}, toolCallId: "call-0", toolName: "render_chart", type: "tool-call" }],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "content",
              value: [
                {
                  data: {
                    type: "url",
                    url: encodeSandboxRef({ mediaType: "image/png", path, size: 4096 }),
                  },
                  filename: "chart.png",
                  mediaType: "image/png",
                  type: "file",
                },
                { text: "x".repeat(800), type: "text" },
              ],
            },
            toolCallId: "call-0",
            toolName: "render_chart",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      user("what does it show?"),
    ];

    const { result } = await compact(messages, { recentWindowSize: 1 });

    const cappedPart = Array.isArray(result[2]?.content) ? result[2].content[0] : undefined;
    const output = cappedPart?.type === "tool-result" ? cappedPart.output : undefined;
    expect(output).toMatchObject({
      type: "content",
      value: [{ text: `Attached file ${path} (image/png)`, type: "text" }, { type: "text" }],
    });
  });

  it("falls back to the annotated text cap when a content output is oversized after stubbing", async () => {
    const longText = "finding line ".repeat(500);
    const messages: ModelMessage[] = [
      user("inspect everything"),
      {
        content: [{ input: {}, toolCallId: "call-0", toolName: "render_chart", type: "tool-call" }],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "content",
              value: [
                { text: longText, type: "text" },
                {
                  data: { data: "iVBORw0KGgo".repeat(500), type: "data" },
                  mediaType: "image/png",
                  type: "file",
                },
              ],
            },
            toolCallId: "call-0",
            toolName: "render_chart",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      user("what did you find?"),
    ];

    const { result, summarizer } = await compact(messages, { recentWindowSize: 1 });

    expect(summarizer).not.toHaveBeenCalled();
    const cappedPart = Array.isArray(result[2]?.content) ? result[2].content[0] : undefined;
    const output = cappedPart?.type === "tool-result" ? cappedPart.output : undefined;
    const value =
      typeof output === "object" && output !== null && "value" in output
        ? String(output.value)
        : "";
    // The prefix cap now truncates stubbed content — readable text — never
    // raw payload bytes.
    expect(value).toContain("Truncated by eve");
    expect(value).toContain("finding line");
    expect(value).not.toContain("iVBORw0KGgo");
  });

  it("keeps the recent tail verbatim, tool results included", async () => {
    const [olderCall, olderResult] = toolExchange({ callId: "call-0", payloadChars: 4_000 });
    const [recentCall, recentResult] = toolExchange({ callId: "call-1", payloadChars: 50 });
    const messages = [
      user("older question"),
      olderCall,
      olderResult,
      user("do the thing"),
      recentCall,
      recentResult,
    ];

    const { result, summarizer } = await compact(messages, { recentWindowSize: 3 });

    expect(summarizer).not.toHaveBeenCalled();
    // A tool-ending tail gets no "Continue." guard, so the exchange is last.
    expect(result.slice(-2)).toEqual([recentCall, recentResult]);
  });

  it("retains the prior checkpoint pair so chaining survives cap-only cycles", async () => {
    const [call, resultMsg] = toolExchange({ callId: "call-0", payloadChars: 4_000 });
    const messages = [
      ...checkpointHead("Previous checkpoint"),
      user("new evidence"),
      call,
      resultMsg,
      user("recent question"),
    ];

    const { result, summarizer } = await compact(messages, { recentWindowSize: 1 });

    expect(summarizer).not.toHaveBeenCalled();
    expect(result[0]).toEqual(compactionMarker(CHECKPOINT_MARKER));
    expect(result[1]).toEqual(assistant("Previous checkpoint"));
  });

  it("keeps a tool result paired with its call when the window would split them", async () => {
    const [call, resultMsg] = toolExchange({ callId: "call-1", payloadChars: 40 });
    // recentWindowSize 2 splits between call and result; the snap pulls the
    // result into the older region, and capping leaves both untouched.
    const messages = [user("old context"), call, resultMsg, user("next question")];

    const { result, summarizer } = await compact(messages, { recentWindowSize: 2 });

    expect(summarizer).not.toHaveBeenCalled();
    expect(result).toContainEqual(call);
    expect(result).toContainEqual(resultMsg);
    expect(result.indexOf(call)).toBeLessThan(result.indexOf(resultMsg));
  });
});

describe("compactMessages: forced summary", () => {
  it("summarizes the full conversation even when it is already under the threshold", async () => {
    const summarize = summarizeWith("forced checkpoint");
    const messages = [user("old message"), assistant("old reply")];

    const result = await compactMessages(
      messages,
      { recentWindowSize: 10, threshold: ROOMY },
      summarize,
      true,
    );

    expect(summarize).toHaveBeenCalledOnce();
    expect(result).toContainEqual({ content: "forced checkpoint", role: "assistant" });
  });
});

describe("compactMessages: summarization fallback", () => {
  it("summarizes when capping cannot free enough space", async () => {
    // All bulk is conversational prose — capping removes nothing — and the
    // threshold sits below the prompt envelope, so no heuristic can be
    // accepted regardless.
    const messages = [user("old context to fold away"), assistant("old reply"), user("continue")];

    const { result, summarizer } = await compact(messages, {
      recentWindowSize: 1,
      summary: "Distilled story",
      threshold: HEURISTICS_FORBIDDEN,
    });

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(summarizer.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain(
      "old context to fold away",
    );
    expect(result[0]).toEqual(compactionMarker(CHECKPOINT_MARKER));
    expect(result[1]).toEqual(assistant("Distilled story"));
    expect(result.some((m) => m.content === "old context to fold away")).toBe(false);
  });

  it("feeds the previous checkpoint to the summarizer untruncated and replaces it", async () => {
    const markerPast280 = "CRITICAL_STATE_AFTER_280_CHARACTERS";
    const previousCheckpoint = `${"completed work ".repeat(24)}${markerPast280}`;
    const messages = [
      ...checkpointHead(previousCheckpoint),
      user(`new evidence ${"findings ".repeat(60)}`),
      assistant("latest response"),
    ];

    const { result, summarizer } = await compact(messages, {
      summary: "Updated checkpoint",
      threshold: HEURISTICS_FORBIDDEN,
    });

    expect(summarizer.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain(previousCheckpoint);
    expect(summarizer.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain(markerPast280);
    expect(result.filter((m) => m.content === previousCheckpoint)).toHaveLength(0);
    expect(result.filter((m) => m.content === "Updated checkpoint")).toHaveLength(1);
  });

  it("keeps the recent window verbatim after summarizing when it fits", async () => {
    // Prose bulk forces summarization; the threshold has room for the tail.
    const oldProse = user("investigation notes ".repeat(2_000));
    const [recentCall, recentResult] = toolExchange({ callId: "call-1", payloadChars: 100 });
    const messages = [oldProse, assistant("done reading"), recentCall, recentResult];

    const { result, summarizer } = await compact(messages, {
      recentWindowSize: 2,
      threshold: 5_000,
    });

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(result.slice(2, 4)).toEqual([recentCall, recentResult]);
  });

  it("replays a folded-away task when recent tool results survive", async () => {
    const task = user("Keep the original request and its final task sentinel.");
    const [call, resultMsg] = toolExchange({ callId: "call-1", payloadChars: 100 });
    const { result, summarizer } = await compact(
      [user("old notes ".repeat(4_000)), task, call, resultMsg],
      { recentWindowSize: 2, threshold: 2_048 },
    );

    expect(summarizer).toHaveBeenCalled();
    expect(result).toContainEqual(call);
    expect(result).toContainEqual(resultMsg);
    expect(result.at(-1)).toEqual(task);
  });

  it("makes room for the original task before keeping a large tool-result tail", async () => {
    const task = user("Keep these requirements. ".repeat(25));
    const [call, resultMsg] = toolExchange({ callId: "call-1", payloadChars: 600 });
    const summary = "s".repeat(2_800);
    const head = checkpointHead(summary);
    const threshold =
      Math.floor(
        (estimateTokens([...head, task]) + estimateTokens([...head, call, resultMsg, task])) / 2,
      ) + ENVELOPE_TOKENS;
    const { result } = await compact([user("old notes ".repeat(4_000)), task, call, resultMsg], {
      recentWindowSize: 2,
      summary,
      threshold,
    });

    expect(result.at(-1)).toEqual(task);
    expect(estimateTokens(result)).toBeLessThanOrEqual(threshold);
  });

  it("strips tool activity from the tail when verbatim does not fit but text does", async () => {
    const oldProse = user("investigation notes ".repeat(2_000));
    const [recentCall, recentResult] = toolExchange({
      callId: "call-1",
      payloadChars: 1_400,
      prose: "Running the tool.",
    });
    const tail = [user("do the thing"), recentCall, recentResult];
    const messages = [oldProse, ...tail];

    // The threshold sits between the stripped and verbatim sizes, and half of
    // it still holds the whole tail, so the window keeps it and only the
    // summary head pushes the verbatim candidate over.
    const summary = "s".repeat(2_400);
    const summaryHead = [compactionMarker(CHECKPOINT_MARKER), assistant(summary)];
    const verbatimSize = estimateTokens([...summaryHead, ...tail]);
    const strippedSize = estimateTokens([
      ...summaryHead,
      user("do the thing"),
      assistant("Running the tool."),
    ]);
    const threshold = Math.floor(verbatimSize) - 50;
    expect(strippedSize).toBeLessThan(threshold);
    expect(verbatimSize).toBeGreaterThan(threshold);
    expect(estimateTokens(tail)).toBeLessThanOrEqual(threshold / 2);

    const { result, summarizer } = await compact(messages, {
      recentWindowSize: 3,
      summary,
      threshold,
    });

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(result).toContainEqual(user("do the thing"));
    expect(result).toContainEqual(assistant("Running the tool."));
    expect(result.some((m) => m.role === "tool")).toBe(false);
  });

  it("folds everything into the summary when even the stripped tail cannot fit", async () => {
    const [call, resultMsg] = toolExchange({ callId: "call-1", payloadChars: 2_000 });
    const messages = [user("Find the relevant rows."), call, resultMsg];

    const { result } = await compact(messages, {
      recentWindowSize: 10,
      summary: "Summary of the large SQL result",
      threshold: HEURISTICS_FORBIDDEN,
    });

    // The folded-away user prompt is replayed as the live turn, so the model
    // resumes against its actual instruction rather than a bare "Continue.".
    expect(result).toEqual([
      compactionMarker(CHECKPOINT_MARKER),
      assistant("Summary of the large SQL result"),
      user("Find the relevant rows."),
    ]);
  });

  it("replays the folded-away user prompt when the tail would trail on assistant content", async () => {
    const messages = [
      user("please fix the flaky test"),
      assistant("working on it"),
      assistant("still going"),
    ];

    const { result } = await compact(messages, {
      recentWindowSize: 1,
      threshold: HEURISTICS_FORBIDDEN,
    });

    expect(result.at(-1)).toEqual(user("please fix the flaky test"));
  });

  it("falls back to a framework continuation when the real user prompt survives in the tail", async () => {
    const messages = [user("old context"), user("latest question"), assistant("answering")];

    const { result } = await compact(messages, {
      recentWindowSize: 2,
      threshold: HEURISTICS_FORBIDDEN,
    });

    // "latest question" is already in the kept tail — replaying it would ask
    // the model to answer again instead of continuing.
    expect(result.at(-1)).toEqual(
      createFrameworkUserMessage("execution.continuation", "Continue."),
    );
    expect(result.filter((m) => m.content === "latest question")).toHaveLength(1);
  });

  it("does not append any resumption when the tail already ends on a user turn", async () => {
    const messages = [user("old"), assistant("old reply"), user("latest question")];

    const { result } = await compact(messages, {
      recentWindowSize: 1,
      threshold: HEURISTICS_FORBIDDEN,
    });

    expect(result.at(-1)).toEqual(user("latest question"));
    expect(result.filter((m) => m.content === "Continue.")).toHaveLength(0);
  });
});

describe("compactMessages: fixed kept-tail budget", () => {
  const THRESHOLD = 10_000;
  const BUDGET = THRESHOLD / 2;

  function bigTaskText(): string {
    return "task context line. ".repeat(1_370);
  }

  function config(history: readonly ModelMessage[], threshold = THRESHOLD): CompactionConfig {
    return {
      lastKnownInputTokens: Math.round(estimateTokens(history)),
      lastKnownPromptMessageCount: history.length,
      recentWindowSize: 4,
      threshold,
    };
  }

  it("keeps the start and end of an oversized request and says the middle was cut", async () => {
    const summarizer = summarizeWith("checkpoint text");
    const history: ModelMessage[] = [
      user("INSTRUCTION FIRST. " + bigTaskText().repeat(2) + "FINAL SENTINEL"),
      ...toolExchange({ callId: "call-0", payloadChars: 50 }),
    ];

    const result = await compactMessages(history, config(history), summarizer);

    const kept = result.filter((message) => message.role === "user" && !isCheckpoint(message));
    expect(kept).toHaveLength(1);
    const content = String(kept[0]?.content);
    expect(content).toContain("FINAL SENTINEL");
    expect(content).toMatch(
      /^INSTRUCTION FIRST\. [\s\S]*\[eve: \d+ characters from the middle of this message were cut/,
    );
    expect(estimateTokens(kept)).toBeLessThanOrEqual(BUDGET);
    expect(summarizer).toHaveBeenCalledOnce();
  });

  it("leaves a request that fits the budget untouched", async () => {
    const task = user("Keep these requirements. ".repeat(40));
    const history: ModelMessage[] = [
      user("old notes ".repeat(4_000)),
      task,
      ...toolExchange({ callId: "call-0", payloadChars: 50 }),
    ];

    const result = await compactMessages(history, config(history), summarizeWith("s"));

    expect(result).toContainEqual(task);
  });

  it("keeps the start and end of a request and sends the cut middle to the summarizer", async () => {
    const summarizer = summarizeWith("checkpoint text");
    const task = user(
      `START SENTINEL${"a".repeat(8_000)}MIDDLE MARKER${"b".repeat(26_000)}END SENTINEL`,
    );
    const history: ModelMessage[] = [task, ...toolExchange({ callId: "call-0", payloadChars: 50 })];

    const result = await compactMessages(history, config(history), summarizer);

    const prompt = String(summarizer.mock.calls[0]?.[0]?.messages?.[0]?.content);
    expect(prompt).toContain("MIDDLE MARKER");
    expect(prompt).not.toContain("START SENTINEL");
    expect(prompt).not.toContain("END SENTINEL");
    expect(JSON.stringify(result)).toContain("START SENTINEL");
    expect(JSON.stringify(result)).toContain("END SENTINEL");
    expect(JSON.stringify(result)).not.toContain("MIDDLE MARKER");
  });

  it("gives the summarizer as much of an oversized head as the budget holds", async () => {
    const summarizer = summarizeWith("checkpoint text");
    const task = user(`${"a ".repeat(5_000)}EARLY MARKER ${"b ".repeat(40_000)}END SENTINEL`);
    const history: ModelMessage[] = [task, ...toolExchange({ callId: "call-0", payloadChars: 50 })];

    await compactMessages(history, config(history), summarizer);

    const prompt = String(summarizer.mock.calls[0]?.[0]?.messages?.[0]?.content);
    expect(prompt).toContain("EARLY MARKER");
    expect(prompt).not.toContain("END SENTINEL");
  });

  it("never splits a surrogate pair at either edge of the cut", async () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    // Padding shifts the pairs against the cut, so across the combinations the
    // start and the end each land mid-pair at least once.
    for (const before of ["", "a", "ab"]) {
      for (const after of ["", "a", "ab"]) {
        const summarizer = summarizeWith("checkpoint text");
        const history: ModelMessage[] = [
          user(`${before}${"\u{1F600}".repeat(20_000)}${after}`),
          ...toolExchange({ callId: "call-0", payloadChars: 50 }),
        ];

        const result = await compactMessages(history, config(history), summarizer);

        const replayed = result.flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        );
        expect(replayed.some((text) => lone.test(text))).toBe(false);
        expect(lone.test(String(summarizer.mock.calls[0]?.[0]?.messages?.[0]?.content))).toBe(
          false,
        );
      }
    }
  });

  it("cuts the text part of a request that carries an attachment", async () => {
    const file = {
      data: new URL("https://example.com/spec.pdf"),
      mediaType: "application/pdf",
      type: "file" as const,
    };
    const task: ModelMessage = {
      content: [{ text: `${bigTaskText().repeat(2)}FINAL SENTINEL`, type: "text" }, file],
      role: "user",
    };
    const history: ModelMessage[] = [task, ...toolExchange({ callId: "call-0", payloadChars: 50 })];

    const result = await compactMessages(
      history,
      config(history),
      summarizeWith("checkpoint text"),
    );

    const kept = result.find(
      (message) => message.role === "user" && Array.isArray(message.content),
    );
    const parts = Array.isArray(kept?.content) ? kept.content : [];
    expect(parts.find((part) => part.type === "text")).toMatchObject({
      text: expect.stringContaining("FINAL SENTINEL"),
    });
    expect(parts).toContainEqual(file);
  });

  it("cuts across every text part of a request", async () => {
    const task: ModelMessage = {
      content: [
        { text: bigTaskText().repeat(2), type: "text" },
        { text: `${bigTaskText()}FINAL SENTINEL`, type: "text" },
      ],
      role: "user",
    };
    const history: ModelMessage[] = [task, ...toolExchange({ callId: "call-0", payloadChars: 50 })];

    const result = await compactMessages(
      history,
      config(history),
      summarizeWith("checkpoint text"),
    );

    const kept = result.find(
      (message) => message.role === "user" && Array.isArray(message.content),
    );
    const texts = (Array.isArray(kept?.content) ? kept.content : []).flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
    expect(texts[0]).toContain("were cut during context compaction");
    expect(texts.join("")).toContain("FINAL SENTINEL");
  });

  it("keeps the start, the end and the file of a request with several text parts", async () => {
    const summarizer = summarizeWith("checkpoint text");
    const file = {
      data: new URL("https://example.com/spec.pdf"),
      mediaType: "application/pdf",
      type: "file" as const,
    };
    const task: ModelMessage = {
      content: [
        { text: "INSTRUCTION FIRST. ", type: "text" },
        { text: `${"a ".repeat(3_000)}MIDDLE MARKER ${bigTaskText().repeat(2)}`, type: "text" },
        file,
        { text: "CLOSING LINE", type: "text" },
      ],
      role: "user",
    };
    const history: ModelMessage[] = [task, ...toolExchange({ callId: "call-0", payloadChars: 50 })];

    const result = await compactMessages(history, config(history), summarizer);

    const kept = result.find(
      (message) => message.role === "user" && Array.isArray(message.content),
    );
    const parts = Array.isArray(kept?.content) ? kept.content : [];
    const texts = parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
    expect(texts[0]).toMatch(/^INSTRUCTION FIRST\. /);
    expect(texts.join("")).toContain("CLOSING LINE");
    expect(texts.join("")).not.toContain("MIDDLE MARKER");
    expect(parts).toContainEqual(file);
    expect(String(summarizer.mock.calls[0]?.[0]?.messages?.[0]?.content)).toContain(
      "MIDDLE MARKER",
    );
  });

  it("sends all of a request's text to the summarizer when none of it fits beside its file", async () => {
    const summarizer = summarizeWith("checkpoint text");
    const file = {
      data: "A".repeat(24_000),
      mediaType: "application/pdf",
      type: "file" as const,
    };
    const task: ModelMessage = {
      content: [{ text: `START SENTINEL ${bigTaskText()}END SENTINEL`, type: "text" }, file],
      role: "user",
    };
    const history: ModelMessage[] = [task, ...toolExchange({ callId: "call-0", payloadChars: 50 })];

    const result = await compactMessages(history, config(history), summarizer);

    const kept = result.find(
      (message) => message.role === "user" && Array.isArray(message.content),
    );
    const texts = (Array.isArray(kept?.content) ? kept.content : []).flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
    expect(texts.join("")).not.toContain("START SENTINEL");
    expect(texts.join("")).not.toContain("END SENTINEL");
    expect(texts.join("")).toContain("were cut during context compaction");
    const prompt = String(summarizer.mock.calls[0]?.[0]?.messages?.[0]?.content);
    expect(prompt).toContain("START SENTINEL");
  });

  it("clips a summary that is over the threshold instead of throwing", async () => {
    const history = [
      ...OLD_BULK,
      user("do the thing"),
      assistant("working on it"),
      user("still there?"),
    ];
    const summarizer = summarizeWith("s".repeat(400_000));

    const result = await compactMessages(
      history,
      { recentWindowSize: 1, threshold: HEURISTICS_FORBIDDEN },
      summarizer,
    );

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(estimateTokens(result)).toBeLessThanOrEqual(HEURISTICS_FORBIDDEN);
    expect(JSON.stringify(result)).toContain("chars omitted");
    expect(result.at(-1)).toEqual(user("still there?"));
  });

  it("clips the summary when compaction shrinks the history but leaves it over the threshold", async () => {
    const history = [user("notes ".repeat(9_000)), assistant("ok"), user("go on")];

    const summarizer = summarizeWith("s".repeat(45_000));
    const result = await compactMessages(
      history,
      { recentWindowSize: 1, threshold: THRESHOLD },
      summarizer,
    );

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(estimateTokens(result)).toBeLessThanOrEqual(THRESHOLD);
    expect(result.at(-1)).toEqual(user("go on"));
  });

  it("swaps a file too big to fit in the request for a note and keeps the text", async () => {
    const request: ModelMessage = {
      content: [
        { text: "Summarize this scan.", type: "text" },
        { data: "A".repeat(200_000), mediaType: "application/pdf", type: "file" },
      ],
      role: "user",
    };
    const summarizer = summarizeWith("checkpoint text");

    const result = await compactMessages(
      [...OLD_BULK, assistant("ok"), request],
      { recentWindowSize: 1, threshold: HEURISTICS_FORBIDDEN + 600 },
      summarizer,
    );

    expect(estimateTokens(result)).toBeLessThanOrEqual(HEURISTICS_FORBIDDEN + 600);
    const last = JSON.stringify(result.at(-1));
    expect(last).toContain("Summarize this scan.");
    expect(last).toContain("file in this message was omitted");
    expect(last).not.toContain("AAAA");
  });

  it("swaps the file for a note when the request is only a file", async () => {
    const request: ModelMessage = {
      content: [{ data: "A".repeat(200_000), mediaType: "application/pdf", type: "file" }],
      role: "user",
    };

    const result = await compactMessages(
      [...OLD_BULK, assistant("ok"), request],
      { recentWindowSize: 1, threshold: HEURISTICS_FORBIDDEN + 600 },
      summarizeWith("checkpoint text"),
    );

    expect(estimateTokens(result)).toBeLessThanOrEqual(HEURISTICS_FORBIDDEN + 600);
    expect(result.at(-1)?.role).toBe("user");
    expect(JSON.stringify(result.at(-1))).toContain("file in this message was omitted");
  });

  it("fills the room it has with the clipped summary", async () => {
    const threshold = 10_000;
    const result = await compactMessages(
      [user("old notes ".repeat(5_000)), assistant("ok"), user("go on")],
      { recentWindowSize: 1, threshold },
      summarizeWith("s".repeat(200_000)),
    );

    expect(estimateTokens(result)).toBeLessThanOrEqual(threshold);
    expect(estimateTokens(result)).toBeGreaterThan(threshold * 0.95);
  });

  it("drops the tail before it clips the summary", async () => {
    const summary = "the whole summary ".repeat(120);
    const history = [
      user("old notes ".repeat(2_000)),
      assistant("a reply ".repeat(200)),
      user("go on"),
    ];

    const result = await compactMessages(
      history,
      { recentWindowSize: 2, threshold: 900 },
      summarizeWith(summary),
    );

    expect(JSON.stringify(result)).toContain(summary);
    expect(JSON.stringify(result)).not.toContain("a reply a reply");
    expect(result.at(-1)).toEqual(user("go on"));
  });

  it("compacts when the request is shorter than its cut note", async () => {
    const result = await compactMessages(
      [...OLD_BULK, assistant("ok"), user("hi")],
      { recentWindowSize: 1, threshold: 60 },
      summarizeWith("x"),
      true,
    );

    expect(result.at(-1)).toEqual(user("hi"));
    expect(estimateTokens(result)).toBeLessThanOrEqual(60);
  });

  it("keeps a file that fits beside the request", async () => {
    const pdf = { data: "A".repeat(48_000), mediaType: "application/pdf", type: "file" as const };
    const request: ModelMessage = {
      content: [{ text: "Review this contract.", type: "text" }, pdf],
      role: "user",
    };
    const threshold = 60_000;
    expect(estimateTokens([request])).toBeLessThan(threshold / 2);

    const result = await compactMessages(
      [user("old notes ".repeat(30_000)), assistant("ok"), request, assistant("Reading it.")],
      { recentWindowSize: 1, threshold },
      summarizeWith("checkpoint text"),
    );

    expect(result).toContainEqual(request);
  });

  it("throws rather than return without the request when the room is below its note", async () => {
    const summarizer = summarizeWith("checkpoint text");

    await expect(
      compactMessages(
        [...OLD_BULK, assistant("ok"), user("Review this contract. ".repeat(200))],
        { recentWindowSize: 1, threshold: 60 },
        summarizer,
      ),
    ).rejects.toThrow(/leave only ~60 tokens/);
    expect(summarizer).not.toHaveBeenCalled();
  });

  it("throws before summarizing when the fixed part alone leaves no room", async () => {
    const summarizer = summarizeWith("checkpoint text");

    await expect(
      compactMessages([...OLD_BULK, user("hi")], { recentWindowSize: 1, threshold: 1 }, summarizer),
    ).rejects.toThrow(/leave only ~1 tokens/);
    expect(summarizer).not.toHaveBeenCalled();
  });

  it("shortens a huge tool result in the kept tail instead of cutting the request or throwing", async () => {
    const request = user("Read the file and report what is in it.");
    const history: ModelMessage[] = [
      user("old notes ".repeat(6_000)),
      assistant("Done."),
      request,
      ...toolExchange({ callId: "call-0", payloadChars: 100_000 }),
    ];

    const result = await compactMessages(
      history,
      { recentWindowSize: 4, threshold: 30_000 },
      summarizeWith("checkpoint text"),
    );

    expect(result).toContainEqual(request);
    expect(JSON.stringify(result)).toContain("Truncated by eve");
    expect(JSON.stringify(result)).not.toContain("cut during context compaction");
    expect(estimateTokens(result)).toBeLessThan(30_000);
  });

  it("keeps the newest tool result whole when no summary is needed", async () => {
    const history: ModelMessage[] = [
      user("go"),
      ...toolExchange({ callId: "call-0", payloadChars: 45_000 }),
      ...toolExchange({ callId: "call-1", payloadChars: 45_000 }),
      ...toolExchange({ callId: "call-2", payloadChars: 30_000 }),
    ];
    const summarizer = summarizeWith("unused");

    const result = await compactMessages(
      history,
      { recentWindowSize: 2, threshold: 30_000 },
      summarizer,
    );

    expect(summarizer).not.toHaveBeenCalled();
    expect(JSON.stringify(result.at(-1))).not.toContain("Truncated by eve");
  });

  it("never keeps more than the budget word for word", async () => {
    const history: ModelMessage[] = [
      user("start"),
      ...Array.from({ length: 12 }, (_, index) =>
        toolExchange({ callId: `call-${index}`, payloadChars: 1_800 }),
      ).flat(),
    ];

    const result = await compactMessages(
      history,
      { recentWindowSize: 40, threshold: 10_000 },
      summarizeWith("checkpoint text"),
      true,
    );

    expect(estimateTokens(result.slice(2))).toBeLessThanOrEqual(BUDGET);
  });

  it("replays the latest request, not an older oversized task, when the latest has no text", async () => {
    const pdfRequest: ModelMessage = {
      content: [
        {
          data: new URL("https://example.com/report.pdf"),
          mediaType: "application/pdf",
          type: "file",
        },
      ],
      role: "user",
    };
    const history: ModelMessage[] = [
      { content: "OBSOLETE TASK ".repeat(4_000), role: "user" },
      assistant("Done."),
      pdfRequest,
      assistant("Working"),
    ];

    const result = await compactMessages(
      history,
      { recentWindowSize: 1, threshold: 10_000 },
      summarizeWith("checkpoint text"),
    );

    expect(JSON.stringify(result)).not.toContain("OBSOLETE TASK");
    expect(result).toContainEqual(pdfRequest);
  });

  it.each([0.8, 0.9])(
    "compacts a few times, not on every step, when the request takes %s of the threshold",
    async (share) => {
      const threshold = 40_000;
      const summarizer = summarizeWith("checkpoint text");
      let history: ModelMessage[] = [
        user("large request ".repeat(Math.floor((threshold * share * 4) / 14))),
      ];
      let compactions = 0;

      for (let step = 1; step <= 20; step += 1) {
        history.push(
          ...toolExchange({
            callId: `call-${step}`,
            payloadChars: Math.floor(threshold * 0.06 * 4),
          }),
        );
        const stepConfig = config(history, threshold);
        if (shouldCompact(history, stepConfig)) {
          compactions += 1;
          history = await compactMessages(history, stepConfig, summarizer);
        }
      }

      expect(compactions).toBeLessThanOrEqual(5);
    },
  );

  it("cuts the request when the previous checkpoint is what pushes the history over the limit", async () => {
    const history: ModelMessage[] = [
      ...checkpointHead("p".repeat(12_000)),
      user("r".repeat(34_000)),
    ];

    const result = await compactMessages(
      history,
      { recentWindowSize: 1, threshold: 10_000 },
      summarizeWith("z".repeat(8_000)),
    );

    expect(JSON.stringify(result)).toContain("were cut during context compaction");
  });

  it("replays a folded-away request whose content is an array of parts", async () => {
    const request: ModelMessage = {
      content: [{ text: "review the storefront", type: "text" }],
      role: "user",
    };
    const history: ModelMessage[] = [request, assistant("Working on it.")];

    const result = await compactMessages(
      history,
      { recentWindowSize: 1, threshold: 10_000 },
      summarizeWith("checkpoint text"),
      true,
    );

    expect(result.at(-1)).toEqual(request);
  });
});

function isCheckpoint(message: ModelMessage): boolean {
  return message.content === CHECKPOINT_MARKER;
}
