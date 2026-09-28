import { describe, expect, it } from "vitest";

import type { LocalTraceSpan } from "./local-trace-reader.js";
import { analyzeLocalTrace } from "./local-trace-analysis.js";
import { summarizeLocalTrace } from "./local-trace-summary.js";

const traceId = "1".repeat(32);

function span(input: {
  readonly attributes?: Record<string, unknown>;
  readonly endMs: number;
  readonly name: string;
  readonly parentSpanId?: string;
  readonly spanId: string;
  readonly startMs: number;
  readonly statusCode?: number;
  readonly statusMessage?: string;
}): LocalTraceSpan {
  return {
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
  };
}

describe("analyzeLocalTrace", () => {
  it("returns an ordered structural timeline and the same summary as search", () => {
    const spans = [
      span({
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
      span({
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
    ];
    const analysis = analyzeLocalTrace(traceId, spans);

    expect(analysis.summary).toEqual(summarizeLocalTrace(traceId, spans));
    expect(analysis).toMatchObject({
      summary: { durationMs: 25, modelCalls: 1, toolCalls: 1 },
      modelWorkMs: 15,
      toolWorkMs: 5,
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
    const action = span({
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
    const execution = span({
      attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "read_file" },
      endMs: 25,
      name: "execute_tool read_file",
      parentSpanId: action.spanId,
      spanId: "b".repeat(16),
      startMs: 20,
      statusCode: 2,
    });
    const analysis = analyzeLocalTrace(traceId, [execution, action], {
      sessionId: "target",
      turnId: "turn-1",
    });

    expect(analysis).toMatchObject({
      summary: { durationMs: 30, toolCalls: 1, errorSpanCount: 2 },
      toolWorkMs: 5,
    });
    expect(analysis.records).toEqual([
      expect.objectContaining({
        callId: "call-1",
        category: "tool",
        error: "Read failed",
        outcome: "failed",
        sessionId: "target",
        spanId: execution.spanId,
        startOffsetMs: 20,
        turnId: "turn-1",
      }),
    ]);
  });

  it("keeps repeated calls distinct and counts tools without execution spans", () => {
    const action = span({
      attributes: { "agent.action.kind": "tool-call", "agent.action.name": "web_search" },
      endMs: 10,
      name: "agent.action",
      spanId: "a".repeat(16),
      startMs: 0,
    });
    const analysis = analyzeLocalTrace(traceId, [action, { ...action, spanId: "b".repeat(16) }]);
    expect(analysis.summary.toolCalls).toBe(2);
    expect(analysis.records).toHaveLength(2);
    expect(analysis.records[0]).toMatchObject({ category: "tool", toolName: "web_search" });
  });

  it("preserves a background action lifetime without adding it to tool work", () => {
    const analysis = analyzeLocalTrace(traceId, [
      span({
        attributes: { "agent.action.kind": "subagent-call", "agent.action.name": "worker" },
        endMs: 100,
        name: "agent.action",
        spanId: "a".repeat(16),
        startMs: 0,
      }),
      span({
        attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "worker" },
        endMs: 10,
        name: "execute_tool worker",
        parentSpanId: "a".repeat(16),
        spanId: "b".repeat(16),
        startMs: 5,
      }),
    ]);
    expect(analysis).toMatchObject({ summary: { durationMs: 100, toolCalls: 1 }, toolWorkMs: 5 });
    expect(analysis.records).toEqual([
      expect.objectContaining({ actionDurationMs: 100, durationMs: 5 }),
    ]);
  });

  it("reports per-model token usage without inventing missing metrics", () => {
    const model = span({
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
    const analysis = analyzeLocalTrace(traceId, [
      model,
      {
        ...model,
        name: "invoke_agent",
        attributes: { "agent.usage.input_tokens": 100 },
        spanId: "b".repeat(16),
      },
      {
        ...model,
        attributes: {
          "gen_ai.operation.name": "chat",
          "agent.usage.input_tokens": -1,
          "agent.usage.output_tokens": Infinity,
        },
        spanId: "c".repeat(16),
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

  it("counts errors outside the timeline and uses the current run identity", () => {
    const analysis = analyzeLocalTrace(
      traceId,
      [
        span({
          attributes: { "agent.run.id": "run-1" },
          endMs: 10,
          name: "agent.step",
          spanId: "a".repeat(16),
          startMs: 0,
          statusCode: 2,
        }),
        span({
          attributes: { "agent.run.id": "run-1", "gen_ai.operation.name": "chat" },
          endMs: 20,
          name: "chat",
          spanId: "b".repeat(16),
          startMs: 10,
        }),
      ],
      { sessionId: "run-1" },
    );
    expect(analysis.summary.errorSpanCount).toBe(1);
    expect(analysis.records).toEqual([
      expect.objectContaining({ category: "model", sessionId: "run-1" }),
    ]);
  });

  it("filters structurally and ignores duplicate span ids", () => {
    const shared = span({
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
      traceId,
      [
        shared,
        shared,
        span({
          attributes: { "agent.session.id": "analyzer", "gen_ai.operation.name": "chat" },
          endMs: 30,
          name: "ai.chat",
          spanId: "b".repeat(16),
          startMs: 20,
        }),
      ],
      { excludeSessionId: "analyzer" },
    );
    expect(analysis.summary.modelCalls).toBe(1);
    expect(analysis.records[0]?.sessionId).toBe("target");
  });

  it("distinguishes overlapping work from elapsed time and other actions from tools", () => {
    const model = span({
      attributes: { "agent.run.id": "run", "gen_ai.operation.name": "chat" },
      endMs: 10,
      name: "chat",
      spanId: "a".repeat(16),
      startMs: 0,
    });
    const analysis = analyzeLocalTrace(traceId, [
      model,
      { ...model, spanId: "b".repeat(16) },
      span({
        attributes: {
          "agent.run.id": "run",
          "agent.action.kind": "subagent-call",
          "agent.action.name": "worker",
        },
        endMs: 10,
        name: "agent.action",
        spanId: "c".repeat(16),
        startMs: 0,
      }),
    ]);
    expect(analysis).toMatchObject({
      summary: { durationMs: 10, modelCalls: 2, toolCalls: 0, toolNames: [] },
      modelWorkMs: 20,
      toolWorkMs: 0,
    });
    expect(analysis.groups).toEqual([
      { sessionId: "run", modelCalls: 2, modelWorkMs: 20, toolCalls: 0, toolWorkMs: 0 },
    ]);
    expect(analysis.records.find((record) => record.category === "other")).toMatchObject({
      actionName: "worker",
    });
  });
});
