import { describe, expect, it } from "vitest";

import type { LocalTraceSpan } from "#tracing/local-trace-reader.js";

import { localTraceSpanCostUsd, summarizeLocalTrace } from "./local-trace-summary.js";

const traceId = "1".repeat(32);

function span(overrides: Partial<LocalTraceSpan> = {}): LocalTraceSpan {
  return {
    attributes: {},
    endTimeNs: 20_000_000n,
    events: [],
    name: "agent.step",
    spanId: "a".repeat(16),
    startTimeNs: 10_000_000n,
    statusCode: 0,
    traceId,
    ...overrides,
  };
}

describe("summarizeLocalTrace", () => {
  it("sums step usage once, ignoring duplicate segments and model counters", () => {
    const step = span({
      attributes: {
        "agent.model.id": "gpt-5",
        "agent.usage.input_tokens": 1000,
        "agent.usage.output_tokens": 100,
        "agent.usage.cache_read_tokens": 800,
        "gen_ai.usage.cost": 0.01,
      },
    });
    const summary = summarizeLocalTrace(traceId, [
      step,
      step,
      span({
        spanId: "b".repeat(16),
        name: "ai.streamText.doStream",
        attributes: {
          "gen_ai.operation.name": "chat",
          "agent.usage.input_tokens": 1000,
          "agent.usage.output_tokens": 100,
          "gen_ai.request.model": "gpt-5",
        },
      }),
      span({
        spanId: "c".repeat(16),
        attributes: {
          "agent.model.id": "claude-sonnet-4",
          "agent.usage.input_tokens": "500",
          "agent.usage.output_tokens": 50,
          "gen_ai.usage.cache_creation.input_tokens": 25,
        },
      }),
    ]);
    expect(summary).toMatchObject({
      inputTokens: 1500,
      outputTokens: 150,
      cacheReadTokens: 800,
      cacheWriteTokens: 25,
      models: ["claude-sonnet-4", "gpt-5"],
      errorSpanCount: 0,
      spanCount: 3,
      modelCalls: 1,
    });
    expect(summary.costUsd).toBeCloseTo(0.01);
  });

  it("collapses tool operations but counts every error span and excludes non-tool actions", () => {
    const spans = [
      span({ statusCode: 2 }),
      span({
        spanId: "b".repeat(16),
        name: "agent.action",
        statusCode: 2,
        attributes: { "agent.action.kind": "tool-call", "agent.action.name": "read" },
      }),
      span({
        spanId: "c".repeat(16),
        parentSpanId: "b".repeat(16),
        name: "execute_tool read",
        statusCode: 2,
        attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "read" },
      }),
      span({
        spanId: "d".repeat(16),
        name: "agent.action",
        attributes: { "agent.action.kind": "subagent-call", "agent.action.name": "worker" },
      }),
    ];
    const summary = summarizeLocalTrace(traceId, spans);
    expect(summary).toMatchObject({
      errorSpanCount: 3,
      toolCalls: 1,
      toolNames: ["read"],
      spanCount: 4,
    });
    expect(summary.costUsd).toBeUndefined();
  });

  it("derives stable identifiers and elapsed time independently of read order", () => {
    const spans = [
      span({
        attributes: {
          "agent.name": "worker",
          "agent.run.id": "child",
          "gen_ai.conversation.id": "conversation",
        },
        endTimeNs: 50_000_000n,
      }),
      span({
        spanId: "b".repeat(16),
        startTimeNs: 0n,
        attributes: {
          "agent.name": "root",
          "agent.session.id": "parent",
          "gen_ai.conversation.id": "conversation",
        },
      }),
    ];
    const summary = summarizeLocalTrace(traceId, spans);
    expect(summary).toMatchObject({
      traceId,
      durationMs: 50,
      startedAt: "1970-01-01T00:00:00.000Z",
      agentNames: ["root", "worker"],
      sessionIds: ["child", "parent"],
      conversationIds: ["conversation"],
    });
    expect(summarizeLocalTrace(traceId, [...spans].reverse())).toEqual(summary);
  });

  it("ignores invalid counters and preserves unavailable cost", () => {
    const summary = summarizeLocalTrace(traceId, [
      span({
        attributes: {
          "agent.usage.input_tokens": Infinity,
          "agent.usage.output_tokens": -1,
          "agent.usage.cache_read_tokens": "NaN",
          "agent.usage.cache_write_tokens": " ",
        },
      }),
    ]);
    expect(summary).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(summary.costUsd).toBeUndefined();
  });

  it("returns an empty summary for a trace with no readable spans", () => {
    expect(summarizeLocalTrace(traceId, [])).toMatchObject({
      traceId,
      spanCount: 0,
      durationMs: 0,
      errorSpanCount: 0,
      modelCalls: 0,
      toolCalls: 0,
    });
  });
});

describe("localTraceSpanCostUsd", () => {
  it("prefers gateway cost and accepts recorded numeric strings", () => {
    expect(
      localTraceSpanCostUsd(
        span({ attributes: { "gen_ai.usage.gateway_cost": "0.0123", "gen_ai.usage.cost": 0.5 } }),
      ),
    ).toBe(0.0123);
  });
});
