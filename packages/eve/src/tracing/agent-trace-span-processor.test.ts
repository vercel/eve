import { describe, expect, it, vi } from "vitest";

import { AgentTraceSpanProcessor } from "#tracing/agent-trace-span-processor.js";

describe("AgentTraceSpanProcessor", () => {
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

    const turn = span("trace-1", { "agent.session.id": "session-1" });
    const user = span("trace-1");
    processor.onStart(turn, {});
    processor.onStart(user, {});
    processor.onEnd(user);
    processor.onEnd(turn);
    expect(child.onStart).toHaveBeenCalledTimes(2);
    expect(child.onEnd).toHaveBeenCalledTimes(2);

    processor.releaseSession("session-1");
    processor.onEnd(span("trace-1"));
    expect(child.onEnd).toHaveBeenCalledTimes(2);
  });

  it("reports open sessions so retention never evicts a live trace", () => {
    const processor = new AgentTraceSpanProcessor([]);
    expect([...processor.activeTraceIds()]).toEqual([]);

    processor.onStart(span("trace-1", { "agent.session.id": "session-1" }), {});
    processor.onStart(span("trace-2", { "agent.session.id": "session-2" }), {});
    expect([...processor.activeTraceIds()].sort()).toEqual(["trace-1", "trace-2"]);

    expect(processor.releaseSession("session-1")).toBe(true);
    expect([...processor.activeTraceIds()]).toEqual(["trace-2"]);
  });

  it("releases every window a session owns", () => {
    const processor = new AgentTraceSpanProcessor([]);
    processor.onStart(span("window-0", { "agent.session.id": "session-1" }), {});
    processor.onStart(span("window-1", { "agent.session.id": "session-1" }), {});
    expect([...processor.activeTraceIds()].sort()).toEqual(["window-0", "window-1"]);

    expect(processor.releaseSession("session-1")).toBe(true);
    expect([...processor.activeTraceIds()]).toEqual([]);
  });

  it("reports no release for a session it never owned", () => {
    const processor = new AgentTraceSpanProcessor([]);

    expect(processor.releaseSession("session-unknown")).toBe(false);
  });

  it("keeps a shared trace pinned when a subagent child finishes first", () => {
    const child = {
      forceFlush: vi.fn(async () => {}),
      onEnd: vi.fn(),
      onStart: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    const processor = new AgentTraceSpanProcessor([child]);
    const owned = {
      "agent.root.session.id": "session-1",
      "agent.session.id": "session-1",
    };
    const delegated = {
      "agent.root.session.id": "session-1",
      "agent.session.id": "child-1",
    };
    processor.onStart(span("trace-1", owned), {});
    processor.onStart(span("trace-1", delegated), {});

    expect(processor.releaseSession("child-1")).toBe(false);
    expect([...processor.activeTraceIds()]).toEqual(["trace-1"]);

    // The parent is still writing to the trace the child recorded into.
    const later = span("trace-1", owned);
    processor.onEnd(later);
    expect(child.onEnd).toHaveBeenCalledWith(later);

    expect(processor.releaseSession("session-1")).toBe(true);
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
    processor.onStart(span("trace-1", { "agent.session.id": "session-1" }), {});

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
