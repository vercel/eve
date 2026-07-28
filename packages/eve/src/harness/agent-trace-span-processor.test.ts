import { describe, expect, it, vi } from "vitest";

import { AgentTraceSpanProcessor } from "#harness/agent-trace-span-processor.js";

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

    expect(processor.releaseSession("session-1")).toBe("trace-1");
    expect([...processor.activeTraceIds()]).toEqual(["trace-2"]);
  });

  it("returns nothing when releasing a session it never owned", () => {
    const processor = new AgentTraceSpanProcessor([]);

    expect(processor.releaseSession("session-unknown")).toBeUndefined();
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
