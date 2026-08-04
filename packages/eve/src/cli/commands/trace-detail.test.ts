import { describe, expect, it } from "vitest";

import type { LocalTraceSpan } from "#tracing/local-trace-reader.js";

import {
  formatCostUsd,
  formatTokenSummary,
  renderSpanDetailLines,
  spanMetricChips,
  summarizeLocalTrace,
} from "./trace-detail.js";

function span(overrides: Partial<LocalTraceSpan> = {}): LocalTraceSpan {
  return {
    attributes: {},
    endTimeNs: 20_000_000n,
    events: [],
    name: "agent.step",
    spanId: "a".repeat(16),
    startTimeNs: 10_000_000n,
    statusCode: 0,
    traceId: "1".repeat(32),
    ...overrides,
  };
}

const identity = (text: string): string => text;

describe("spanMetricChips", () => {
  it("emits token, cost, and tool chips only when present", () => {
    expect(
      spanMetricChips(
        span({
          attributes: {
            "agent.usage.input_tokens": 1400,
            "agent.usage.output_tokens": 213,
            "gen_ai.usage.gateway_cost": 0.0031,
          },
        }),
      ),
    ).toEqual(["↑1.4K", "↓213", "$0.0031"]);

    expect(spanMetricChips(span())).toEqual([]);
    expect(
      spanMetricChips(
        span({ name: "ai.toolCall", attributes: { "gen_ai.tool.name": "get_weather" } }),
      ),
    ).toEqual(["get_weather"]);
  });

  it("prefers gateway cost over provider cost and parses string ints", () => {
    expect(
      spanMetricChips(
        span({ attributes: { "gen_ai.usage.cost": 0.5, "agent.usage.input_tokens": "900" } }),
      ),
    ).toEqual(["↑900", "$0.5000"]);
  });
});

describe("summarizeLocalTrace", () => {
  it("sums usage over agent.step spans only, avoiding double counts", () => {
    const summary = summarizeLocalTrace([
      span({
        attributes: {
          "agent.model.id": "gpt-5",
          "agent.usage.input_tokens": 1000,
          "agent.usage.output_tokens": 100,
          "gen_ai.usage.cache_read.input_tokens": 800,
          "gen_ai.usage.cost": 0.01,
        },
      }),
      // Same usage repeated on the model span must not double-count.
      span({
        name: "ai.streamText.doStream",
        attributes: {
          "agent.usage.input_tokens": 1000,
          "agent.usage.output_tokens": 100,
          "gen_ai.request.model": "gpt-5",
        },
      }),
      span({
        attributes: {
          "agent.model.id": "claude-sonnet-4",
          "agent.usage.input_tokens": 500,
          "agent.usage.output_tokens": 50,
        },
      }),
    ]);

    expect(summary.inputTokens).toBe(1500);
    expect(summary.outputTokens).toBe(150);
    expect(summary.cacheReadTokens).toBe(800);
    expect(summary.costUsd).toBeCloseTo(0.01);
    expect(summary.models).toEqual(["gpt-5", "claude-sonnet-4"]);
    expect(summary.errorCount).toBe(0);
  });

  it("reports errors and leaves cost undefined when unreported", () => {
    const summary = summarizeLocalTrace([span({ statusCode: 2 }), span()]);
    expect(summary.errorCount).toBe(1);
    expect(summary.costUsd).toBeUndefined();
  });
});

describe("formatTokenSummary / formatCostUsd", () => {
  it("formats the header tokens row with cache parts when present", () => {
    expect(
      formatTokenSummary({
        cacheReadTokens: 1100,
        cacheWriteTokens: 0,
        errorCount: 0,
        inputTokens: 1200,
        models: [],
        outputTokens: 340,
      }),
    ).toBe("↑1.2K in · ↓340 out · 1.1K cached");
  });

  it("scales cost precision", () => {
    expect(formatCostUsd(0.0031)).toBe("$0.0031");
    expect(formatCostUsd(1.5)).toBe("$1.50");
  });
});

describe("renderSpanDetailLines", () => {
  it("renders facts, sorted attributes, and events with offsets", () => {
    const lines = renderSpanDetailLines(
      span({
        attributes: {
          "agent.model.id": "gpt-5",
          "gen_ai.tool.call.arguments": '{"city":"SF"}',
        },
        events: [
          { attributes: {}, name: "step.started", timeNs: 10_000_000n },
          {
            attributes: { "step.index": 0 },
            name: "step.completed",
            timeNs: 19_500_000n,
          },
        ],
        parentSpanId: "b".repeat(16),
        scope: "eve.agent",
      }),
      { dim: identity, width: 80 },
    );

    expect(lines).toEqual([
      "status: ok",
      "duration: 10ms",
      `started: ${new Date(10).toISOString()}`,
      `span: ${"a".repeat(16)}`,
      `parent: ${"b".repeat(16)}`,
      "scope: eve.agent",
      "agent.model.id: gpt-5",
      "gen_ai.tool.call.arguments:",
      "  {",
      '    "city": "SF"',
      "  }",
      "events:",
      "  step.started  +0ms",
      "  step.completed  +10ms",
      "    step.index: 0",
    ]);
  });

  it("shows the status message on error spans and kind when non-internal", () => {
    const lines = renderSpanDetailLines(
      span({ kind: 2, statusCode: 2, statusMessage: "model call failed" }),
      { dim: identity, width: 80 },
    );

    expect(lines[0]).toBe("status: ERROR — model call failed");
    expect(lines).toContain("kind: server");
  });

  it("sanitizes attribute keys, values, and event names", () => {
    const lines = renderSpanDetailLines(
      span({
        attributes: { "evil\x1b[2Jkey": "va\x1b[31mlue" },
        events: [{ attributes: {}, name: "bad\x1b]0;owned\x07event", timeNs: 10_000_000n }],
      }),
      { dim: identity, width: 80 },
    );

    const joined = lines.join("\n");
    expect(joined).not.toContain("\x1b");
    expect(joined).not.toContain("\x07");
    expect(joined).toContain("evil");
    expect(joined).toContain("badevent");
  });
});
