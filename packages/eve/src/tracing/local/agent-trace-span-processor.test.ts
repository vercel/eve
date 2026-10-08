import { describe, expect, it, vi } from "vitest";

import { AgentTraceSpanProcessor } from "#tracing/local/agent-trace-span-processor.js";

describe("AgentTraceSpanProcessor", () => {
  it("adopts the activation owner after a third-party span arrives first", () => {
    const processor = new AgentTraceSpanProcessor([]);
    const attributes = { "gen_ai.conversation.id": "conversation" };
    processor.onStart(span("trace", attributes), {});
    const activation = {
      ...span("trace", {
        ...attributes,
        "agent.run.id": "run",
        "agent.turn.id": "turn_0",
        "gen_ai.operation.name": "invoke_agent",
      }),
      name: "invoke_agent root",
    };
    processor.onStart(activation, {});
    processor.onEnd(activation);
    expect(processor.releaseCompletedTraces()).toBe(true);
    expect([...processor.activeTraceIds()]).toEqual([]);
  });
  it("routes an agent trace and releases it at session terminal", () => {
    const child = {
      forceFlush: vi.fn(async () => {}),
      onEnd: vi.fn(),
      onStart: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    const processor = new AgentTraceSpanProcessor([child]);
    const unrelated = span("unrelated");
    processor.onStart(unrelated, {});
    processor.onEnd(unrelated);
    expect(child.onStart).not.toHaveBeenCalled();

    const turn = span("trace-1", { "gen_ai.conversation.id": "session-1" });
    const user = span("trace-1");
    processor.onStart(turn, {});
    processor.onStart(user, {});
    processor.onEnd(user);
    processor.onEnd(turn);
    expect(child.onStart).toHaveBeenCalledTimes(2);
    expect(child.onEnd).toHaveBeenCalledTimes(2);

    processor.releaseConversation("session-1");
    processor.onEnd(span("trace-1"));
    expect(child.onEnd).toHaveBeenCalledTimes(2);
  });

  it("reports open sessions so retention never evicts a live trace", () => {
    const processor = new AgentTraceSpanProcessor([]);
    expect([...processor.activeTraceIds()]).toEqual([]);

    processor.onStart(span("trace-1", { "gen_ai.conversation.id": "session-1" }), {});
    processor.onStart(span("trace-2", { "gen_ai.conversation.id": "session-2" }), {});
    expect([...processor.activeTraceIds()].sort()).toEqual(["trace-1", "trace-2"]);

    expect(processor.releaseConversation("session-1")).toBe(true);
    expect([...processor.activeTraceIds()]).toEqual(["trace-2"]);
  });

  it("releases every trace a session owns", () => {
    const processor = new AgentTraceSpanProcessor([]);
    processor.onStart(span("trace-1", { "gen_ai.conversation.id": "session-1" }), {});
    processor.onStart(span("trace-2", { "gen_ai.conversation.id": "session-1" }), {});
    expect([...processor.activeTraceIds()].sort()).toEqual(["trace-1", "trace-2"]);

    expect(processor.releaseConversation("session-1")).toBe(true);
    expect([...processor.activeTraceIds()]).toEqual([]);
  });

  it("reports no release for a session it never owned", () => {
    const processor = new AgentTraceSpanProcessor([]);

    expect(processor.releaseConversation("session-unknown")).toBe(false);
  });

  it("keeps a shared trace pinned when a subagent child finishes first", () => {
    const child = {
      forceFlush: vi.fn(async () => {}),
      onEnd: vi.fn(),
      onStart: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    const processor = new AgentTraceSpanProcessor([child]);
    const owned = { "gen_ai.conversation.id": "session-1" };
    const root = {
      ...span("trace-1", {
        ...owned,
        "agent.run.id": "root-session",
        "agent.turn.id": "turn_0",
        "gen_ai.operation.name": "invoke_agent",
      }),
      name: "invoke_agent root",
    };
    const delegated = {
      ...root,
      attributes: { ...root.attributes, "agent.run.id": "child-session" },
      name: "invoke_agent child",
      parentSpanContext: { spanId: "caller" },
    };
    processor.onStart(root, {});
    processor.onStart(delegated, {});
    processor.onEnd(delegated);
    processor.releaseCompletedTraces();

    expect(processor.releaseConversation("child-1")).toBe(false);
    expect([...processor.activeTraceIds()]).toEqual(["trace-1"]);

    // The parent is still writing to the trace the child recorded into.
    const later = span("trace-1", owned);
    processor.onEnd(later);
    expect(child.onEnd).toHaveBeenCalledWith(later);

    processor.onEnd(root);
    expect(processor.releaseCompletedTraces()).toBe(true);
    expect([...processor.activeTraceIds()]).toEqual([]);
  });

  it("excludes Workflow instrumentation from an agent trace", () => {
    const child = {
      forceFlush: vi.fn(async () => {}),
      onEnd: vi.fn(),
      onStart: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    const processor = new AgentTraceSpanProcessor([child]);
    processor.onStart(span("trace-1", { "gen_ai.conversation.id": "session-1" }), {});

    const workflow = span("trace-1", {}, "workflow");
    processor.onStart(workflow, {});
    processor.onEnd(workflow);

    expect(child.onStart).toHaveBeenCalledTimes(1);
    expect(child.onEnd).not.toHaveBeenCalled();
  });
});

function span(
  traceId: string,
  attributes: Record<string, unknown> = {},
  scope = "test",
): {
  readonly attributes: Record<string, unknown>;
  readonly instrumentationScope: { readonly name: string };
  readonly spanContext: () => { readonly traceId: string };
} {
  return {
    attributes,
    instrumentationScope: { name: scope },
    spanContext: () => ({ traceId }),
  };
}
