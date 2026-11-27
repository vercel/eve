import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  estimateRatio,
  getInputTokenCount,
  withoutPromptMeasurement,
  withPromptMeasurement,
} from "#harness/compaction/engine.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { CompactionConfig } from "#harness/types.js";
import { encodeSandboxRef } from "#internal/attachments/sandbox-refs.js";
import { pngBytes } from "#internal/testing/media-fixtures.js";
import { shouldCompact } from "#internal/testing/compaction-trigger.js";

const config: CompactionConfig & { readonly threshold: number } = {
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

  it("scales appended message estimates by calibrated estimateRatio capped at 1.6", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "initial" },
      { role: "assistant", content: "x".repeat(400) },
    ];
    const appendedTokens = estimateTokens([messages[1]!]);
    const scaled = getInputTokenCount(messages, {
      ...config,
      estimateRatio: 1.5,
      lastKnownInputTokens: 10_000,
      lastKnownPromptMessageCount: 1,
    });
    expect(scaled).toBe(10_000 + Math.ceil(appendedTokens * 1.5));

    const capped = getInputTokenCount(messages, {
      ...config,
      estimateRatio: 15,
      lastKnownInputTokens: 8_000,
      lastKnownPromptMessageCount: 1,
    });
    expect(capped).toBe(8_000 + Math.ceil(appendedTokens * 1.6));
  });

  it("does not prematurely compact when synthetic usage inflates estimateRatio above 1.6", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: `Seed 0: ${"Preserve this repository evidence. ".repeat(40)}` },
      { role: "assistant", content: "Seed evidence recorded. ".repeat(64) },
      { role: "user", content: `Seed 1: ${"Preserve this repository evidence. ".repeat(40)}` },
    ];
    const measured = withPromptMeasurement(
      {},
      {
        inputTokens: 8_000,
        modelId: "mock",
        promptMessageCount: 1,
        promptMessages: [messages[0]!],
        requestEnvelopeTokens: 200,
      },
    );
    expect(measured.estimateRatio).toBeGreaterThan(10);
    expect(
      shouldCompact(
        messages,
        { ...config, ...measured, threshold: 10_000 },
        200,
        measured.requestEnvelopeTokens,
      ),
    ).toBe(false);
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

  it("does not compact an empty history based on prompt overhead alone", () => {
    expect(shouldCompact([], { ...config, threshold: 0 })).toBe(false);
  });

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
        threshold: 180_000,
      }),
    ).toBe(true);
  });
});

describe("compaction state: prompt measurement", () => {
  it("sets the estimate ratio from the provider's count over the estimate", () => {
    const promptMessages = [{ role: "user" as const, content: "x".repeat(4_000) }];
    const envelope = 100_000;
    const next = withPromptMeasurement(
      {},
      {
        inputTokens: 186_000,
        modelId: "model-a",
        promptMessageCount: 10,
        promptMessages,
        requestEnvelopeTokens: envelope,
      },
    );

    expect(next.estimateRatio).toBeCloseTo(
      186_000 / (estimateTokens(promptMessages) + envelope),
      6,
    );
    expect(next.requestEnvelopeTokens).toBe(envelope);
    expect(next.lastKnownInputTokens).toBe(186_000);
    expect(next.lastKnownPromptMessageCount).toBe(10);
  });

  it("keeps the previous ratio when the measurement has no estimate", () => {
    const next = withPromptMeasurement(
      { estimateRatio: 1.2 },
      { inputTokens: 186_000, modelId: "model-a", promptMessageCount: 10 },
    );

    expect(next.estimateRatio).toBe(1.2);
  });

  it("uses 1.6 until a call is measured", () => {
    expect(estimateRatio({})).toBe(1.6);
    expect(estimateRatio({ estimateRatio: 1.3 })).toBe(1.3);
  });

  it("keeps the ratio and the recent-rewrite mark when the measurement is dropped", () => {
    const next = withoutPromptMeasurement({
      estimateRatio: 1.3,
      lastKnownInputTokens: 186_000,
      lastKnownPromptMessageCount: 10,
      recentRewrite: true,
    });

    expect(next).toEqual({ estimateRatio: 1.3, recentRewrite: true });
  });

  it("keeps the recent-rewrite mark through the first measurement after a rewrite and drops it on the next", () => {
    const rewritten = withoutPromptMeasurement({
      estimateRatio: 1.3,
      lastKnownInputTokens: 186_000,
      lastKnownPromptMessageCount: 40,
      recentRewrite: true,
    });
    const measurement = {
      inputTokens: 130_000,
      modelId: "model-a",
      promptMessageCount: 6,
      promptMessages: [],
      requestEnvelopeTokens: 100_000,
    };

    const first = withPromptMeasurement(rewritten, measurement);
    expect(first.recentRewrite).toBe(true);

    const second = withPromptMeasurement(first, { ...measurement, promptMessageCount: 8 });
    expect(second.recentRewrite).toBeUndefined();
    expect(second.estimateRatio).toBeCloseTo(1.3, 3);
  });

  it("drops the recent-rewrite mark when the first call after a rewrite reports no input tokens", () => {
    let state = withoutPromptMeasurement({ estimateRatio: 1.3, recentRewrite: true });
    for (let call = 0; call < 6; call += 1) {
      state = withPromptMeasurement(state, { modelId: "model-a" });
    }

    expect(state.recentRewrite).toBeUndefined();
    expect(state.estimateRatio).toBe(1.3);
  });
});
