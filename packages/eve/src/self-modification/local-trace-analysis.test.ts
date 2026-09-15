import { describe, expect, it } from "vitest";

import { analyzeLocalTrace } from "./local-trace-analysis.js";

const traceId = "1".repeat(32);

function source(input: {
  readonly attributes?: Record<string, unknown>;
  readonly endMs: number;
  readonly name: string;
  readonly parentSpanId?: string;
  readonly spanId: string;
  readonly startMs: number;
  readonly statusCode?: number;
  readonly statusMessage?: string;
}): Parameters<typeof analyzeLocalTrace>[0][number] {
  return {
    segmentFile: `${input.spanId}.otlp.json`,
    span: {
      attributes: input.attributes ?? {},
      endTimeNs: BigInt(input.endMs) * 1_000_000n,
      events: [],
      name: input.name,
      parentSpanId: input.parentSpanId,
      spanId: input.spanId,
      startTimeNs: BigInt(input.startMs) * 1_000_000n,
      statusCode: input.statusCode ?? 0,
      statusMessage: input.statusMessage,
      traceId,
    },
  };
}

describe("analyzeLocalTrace", () => {
  it("returns an ordered structural timeline with span ids", () => {
    const analysis = analyzeLocalTrace([
      source({
        attributes: {
          "agent.session.id": "child",
          "agent.turn.id": "turn-1",
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "read_file",
        },
        endMs: 25,
        name: "execute_tool read_file",
        spanId: "b".repeat(16),
        startMs: 20,
      }),
      source({
        attributes: {
          "agent.model.id": "test-model",
          "agent.session.id": "child",
          "agent.turn.id": "turn-1",
          "gen_ai.operation.name": "chat",
        },
        endMs: 15,
        name: "ai.chat",
        spanId: "a".repeat(16),
        startMs: 0,
      }),
    ]);

    expect(analysis).toMatchObject({
      durationMs: 25,
      modelCalls: 1,
      modelDurationMs: 15,
      toolCalls: 1,
      toolDurationMs: 5,
    });
    expect(analysis.records).toEqual([
      expect.objectContaining({
        category: "model",
        model: "test-model",
        spanId: "a".repeat(16),
        startOffsetMs: 0,
      }),
      expect.objectContaining({
        category: "tool",
        spanId: "b".repeat(16),
        startOffsetMs: 20,
        toolName: "read_file",
      }),
    ]);
  });

  it("collapses action wrappers, retaining execution timing and inherited selectors", () => {
    const action = source({
      attributes: {
        "agent.action.kind": "tool-call",
        "agent.action.name": "read_file",
        "agent.action.call_id": "call-1",
        "agent.session.id": "target",
        "agent.turn.id": "turn-1",
      },
      endMs: 30,
      name: "agent.action",
      spanId: "a".repeat(16),
      startMs: 0,
      statusCode: 2,
      statusMessage: "Read failed",
    });
    const execution = source({
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "read_file",
      },
      endMs: 25,
      name: "execute_tool read_file",
      parentSpanId: action.span.spanId,
      spanId: "b".repeat(16),
      startMs: 20,
    });
    const analysis = analyzeLocalTrace([execution, action], {
      sessionId: "target",
      turnId: "turn-1",
    });

    expect(analysis).toMatchObject({ durationMs: 30, toolCalls: 1, toolDurationMs: 5 });
    expect(analysis.records).toEqual([
      expect.objectContaining({
        callId: "call-1",
        category: "tool",
        error: "Read failed",
        outcome: "failed",
        sessionId: "target",
        spanId: execution.span.spanId,
        startOffsetMs: 20,
        turnId: "turn-1",
      }),
    ]);
  });

  it("keeps repeated calls distinct and counts tools without execution spans", () => {
    const action = source({
      attributes: { "agent.action.kind": "tool-call", "agent.action.name": "web_search" },
      endMs: 10,
      name: "agent.action",
      spanId: "a".repeat(16),
      startMs: 0,
    });
    const analysis = analyzeLocalTrace([
      action,
      { ...action, span: { ...action.span, spanId: "b".repeat(16) } },
    ]);

    expect(analysis.toolCalls).toBe(2);
    expect(analysis.records).toHaveLength(2);
    expect(analysis.records[0]).toMatchObject({ category: "tool", toolName: "web_search" });
  });

  it("preserves a background action lifetime without adding it to tool execution time", () => {
    const analysis = analyzeLocalTrace([
      source({
        attributes: { "agent.action.kind": "subagent-call", "agent.action.name": "worker" },
        endMs: 100,
        name: "agent.action",
        spanId: "a".repeat(16),
        startMs: 0,
      }),
      source({
        attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "worker" },
        endMs: 10,
        name: "execute_tool worker",
        parentSpanId: "a".repeat(16),
        spanId: "b".repeat(16),
        startMs: 5,
      }),
    ]);

    expect(analysis).toMatchObject({ durationMs: 100, toolCalls: 1, toolDurationMs: 5 });
    expect(analysis.records).toEqual([
      expect.objectContaining({ actionDurationMs: 100, durationMs: 5 }),
    ]);
  });

  it("reports per-model token usage without adding turn totals or inventing missing metrics", () => {
    const model = source({
      attributes: {
        "gen_ai.operation.name": "chat",
        "agent.usage.input_tokens": 100,
        "agent.usage.output_tokens": 10,
        "agent.usage.cache_read_tokens": 80,
        "agent.usage.cache_write_tokens": 0,
      },
      endMs: 10,
      name: "chat test-model",
      spanId: "a".repeat(16),
      startMs: 0,
    });
    const analysis = analyzeLocalTrace([
      model,
      {
        ...model,
        span: {
          ...model.span,
          name: "invoke_agent",
          attributes: { "agent.usage.input_tokens": 100 },
          spanId: "b".repeat(16),
        },
      },
      {
        ...model,
        span: {
          ...model.span,
          attributes: {
            "gen_ai.operation.name": "chat",
            "agent.usage.input_tokens": -1,
            "agent.usage.output_tokens": Infinity,
          },
          spanId: "c".repeat(16),
        },
      },
    ]);

    expect(analysis.records).toHaveLength(2);
    expect(analysis.records[0]?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    });
    expect(analysis.records[1]?.usage).toBeUndefined();
  });

  it("counts failures on structural spans and uses the current run identity", () => {
    const analysis = analyzeLocalTrace(
      [
        source({
          attributes: { "agent.run.id": "run-1" },
          endMs: 10,
          name: "agent.step",
          spanId: "a".repeat(16),
          startMs: 0,
          statusCode: 2,
        }),
        source({
          attributes: { "agent.run.id": "run-1", "gen_ai.operation.name": "chat" },
          endMs: 20,
          name: "chat",
          spanId: "b".repeat(16),
          startMs: 10,
        }),
      ],
      { sessionId: "run-1" },
    );

    expect(analysis.failedOperations).toBe(1);
    expect(analysis.records).toEqual([
      expect.objectContaining({ category: "model", sessionId: "run-1" }),
    ]);
  });

  it("filters structurally and ignores duplicate span ids", () => {
    const shared = source({
      attributes: {
        "agent.session.id": "target",
        "agent.turn.id": "turn-1",
        "gen_ai.operation.name": "chat",
      },
      endMs: 10,
      name: "ai.chat",
      spanId: "a".repeat(16),
      startMs: 0,
    });
    const analysis = analyzeLocalTrace(
      [
        shared,
        { ...shared, segmentFile: "duplicate.otlp.json" },
        source({
          attributes: { "agent.session.id": "analyzer", "gen_ai.operation.name": "chat" },
          endMs: 30,
          name: "ai.chat",
          spanId: "b".repeat(16),
          startMs: 20,
        }),
      ],
      { excludeSessionId: "analyzer" },
    );

    expect(analysis.modelCalls).toBe(1);
    expect(analysis.records[0]?.sessionId).toBe("target");
  });
});
