import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COMPACTION_PROMPT_ENVELOPE } from "#harness/compaction-prompt.js";
import {
  compactMessages,
  getInputTokenCount,
  resolveCompactionModel,
  shouldCompact,
} from "#harness/compaction.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { CompactionConfig } from "#harness/types.js";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const config: CompactionConfig = {
  recentWindowSize: 2,
  threshold: 100,
};

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
});

describe("getInputTokenCount", () => {
  it("prefers the last known exact token count when available", () => {
    const messages: ModelMessage[] = [{ content: "a".repeat(400), role: "user" }];

    const result = getInputTokenCount(messages, {
      ...config,
      lastKnownInputTokens: 42,
      lastKnownPromptMessageCount: 1,
    });
    // No appended messages — tail is empty. The rough estimate adds a tiny
    // constant for the "[]" serialization; the exact prior count dominates.
    expect(result).toBeGreaterThanOrEqual(42);
    expect(result).toBeLessThan(43);
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
      { content: COMPACTION_PROMPT_ENVELOPE.prompt, role: "user" },
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
});

describe("resolveCompactionModel", () => {
  it("reuses the active model when compaction uses the same reference", async () => {
    const model = {} as Parameters<typeof resolveCompactionModel>[0]["model"];
    const resolveModel = vi.fn();

    const result = await resolveCompactionModel({
      model,
      modelReference: { id: "main", providerOptions: { openai: { reasoning: { effort: "low" } } } },
      resolveModel,
    });

    expect(result.model).toBe(model);
    expect(result.providerOptions).toEqual({
      openai: { reasoning: { effort: "low" } },
    });
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("resolves the authored compaction model when configured", async () => {
    const model = {} as Parameters<typeof resolveCompactionModel>[0]["model"];
    const summaryModel = {} as Parameters<typeof resolveCompactionModel>[0]["model"];
    const resolveModel = vi.fn().mockResolvedValue(summaryModel);

    const compactionModelReference = {
      id: "summary",
      providerOptions: {
        anthropic: {
          thinking: {
            budget_tokens: 128,
          },
        },
      },
    } as Parameters<typeof resolveCompactionModel>[0]["compactionModelReference"];

    const result = await resolveCompactionModel({
      compactionModelReference,
      model,
      modelReference: { id: "main" },
      resolveModel,
    });

    expect(result.model).toBe(summaryModel);
    expect(result.providerOptions).toEqual({
      anthropic: {
        thinking: {
          budget_tokens: 128,
        },
      },
    });
    expect(resolveModel).toHaveBeenCalledWith(compactionModelReference);
  });
});

// --- compactMessages ---------------------------------------------------
//
// compactMessages escalates through heuristics before summarizing, and which
// strategy a test hits is pure threshold arithmetic:
//
// - The tool-result cap heuristic is accepted only when the capped history
//   PLUS the fixed compaction prompt envelope fits the threshold.
//   `HEURISTICS_FORBIDDEN` sits below the envelope estimate, so no heuristic
//   can be accepted and the summarization fallback always runs.
// - `ROOMY` accepts capping whenever the history's bulk is tool output.
//
// Every result is checked against `expectWellFormedCompaction`: no orphaned
// tool_result, never trailing on an assistant message, and — unless the
// window was exhausted — within the threshold on shouldCompact's own ruler,
// so the result cannot immediately re-trigger compaction.

const ENVELOPE_TOKENS = estimateTokens([
  { content: COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
  { content: COMPACTION_PROMPT_ENVELOPE.prompt, role: "user" },
] satisfies ModelMessage[]);
const HEURISTICS_FORBIDDEN = Math.floor(ENVELOPE_TOKENS);
const ROOMY = 100_000;

const CHECKPOINT_MARKER = "Summary of our conversation so far:";

function user(text: string): ModelMessage {
  return { content: text, role: "user" };
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

function checkpointHead(text: string): ModelMessage[] {
  return [user(CHECKPOINT_MARKER), assistant(text)];
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
): Promise<{ result: ModelMessage[]; summarizer: ReturnType<typeof vi.mocked<never>> }> {
  const { generateText } = await import("ai");
  const summarizer = vi.mocked(generateText);
  summarizer.mockResolvedValue({
    text: overrides.summary ?? "checkpoint text",
  } as Awaited<ReturnType<typeof generateText>>);

  const compactionConfig: CompactionConfig = {
    recentWindowSize: overrides.recentWindowSize ?? 4,
    threshold: overrides.threshold ?? ROOMY,
  };
  const result = await compactMessages(
    messages,
    {} as Parameters<typeof compactMessages>[1],
    compactionConfig,
  );

  expectWellFormedCompaction(result, compactionConfig.threshold);
  return { result, summarizer: summarizer as ReturnType<typeof vi.mocked<never>> };
}

describe("compactMessages: tool-result cap heuristic", () => {
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
    expect(result[0]).toEqual(user(CHECKPOINT_MARKER));
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
    expect(summarizer.mock.calls[0]?.[0]?.prompt).toContain("old context to fold away");
    expect(result[0]).toEqual(user(CHECKPOINT_MARKER));
    expect(result[1]).toEqual(assistant("Distilled story"));
    expect(result.some((m) => m.content === "old context to fold away")).toBe(false);
  });

  it("feeds the previous checkpoint to the summarizer untruncated and replaces it", async () => {
    const markerPast280 = "CRITICAL_STATE_AFTER_280_CHARACTERS";
    const previousCheckpoint = `${"completed work ".repeat(24)}${markerPast280}`;
    const messages = [
      ...checkpointHead(previousCheckpoint),
      user("new evidence"),
      assistant("latest response"),
    ];

    const { result, summarizer } = await compact(messages, {
      summary: "Updated checkpoint",
      threshold: HEURISTICS_FORBIDDEN,
    });

    expect(summarizer.mock.calls[0]?.[0]?.prompt).toContain(previousCheckpoint);
    expect(summarizer.mock.calls[0]?.[0]?.prompt).toContain(markerPast280);
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

  it("strips tool activity from the tail when verbatim does not fit but text does", async () => {
    const oldProse = user("investigation notes ".repeat(2_000));
    const [recentCall, recentResult] = toolExchange({
      callId: "call-1",
      payloadChars: 1_400,
      prose: "Running the tool.",
    });
    const tail = [user("do the thing"), recentCall, recentResult];
    const messages = [oldProse, ...tail];

    // Derive a threshold between the stripped and verbatim tail sizes so the
    // regime is explicit rather than encoded in magic numbers. The summary is
    // sized to exceed the window-selection reserve, which is what makes the
    // verbatim tail overshoot after the summary head is added.
    const summary = "s".repeat(2_400);
    const summaryHead = [user(CHECKPOINT_MARKER), assistant(summary)];
    const verbatimSize = estimateTokens([...summaryHead, ...tail]);
    const strippedSize = estimateTokens([
      ...summaryHead,
      user("do the thing"),
      assistant("Running the tool."),
    ]);
    const threshold = Math.floor((verbatimSize + strippedSize) / 2);
    expect(strippedSize).toBeLessThan(threshold);
    expect(verbatimSize).toBeGreaterThan(threshold);

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
      user(CHECKPOINT_MARKER),
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

  it("falls back to a synthetic resumption when the real user prompt survives in the tail", async () => {
    const messages = [user("old context"), user("latest question"), assistant("answering")];

    const { result } = await compact(messages, {
      recentWindowSize: 2,
      threshold: HEURISTICS_FORBIDDEN,
    });

    // "latest question" is already in the kept tail — replaying it would ask
    // the model to answer again instead of continuing.
    expect(result.at(-1)).toEqual(user("Continue."));
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

  it("forwards model options to the summarization call", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValue({
      text: "summary",
    } as Awaited<ReturnType<typeof generateText>>);

    const messages = [user("old message"), assistant("old reply"), user("continue")];
    const model = {} as Parameters<typeof compactMessages>[1];
    const providerOptions = { anthropic: { thinking: { budget_tokens: 128 } } };
    const headers = { "x-title": "My Agent" };
    const abortController = new AbortController();

    await compactMessages(
      messages,
      model,
      { recentWindowSize: 1, threshold: HEURISTICS_FORBIDDEN },
      providerOptions,
      undefined,
      headers,
      abortController.signal,
    );

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: abortController.signal,
        headers,
        model,
        providerOptions,
      }),
    );
  });
});
