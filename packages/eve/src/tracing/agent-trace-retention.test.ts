import { describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import {
  ContextAgentTraceStateStore,
  pruneAgentTraceState,
} from "#tracing/agent-trace-context-store.js";
import { AGENT_TRACE_CONTEXT_KEY } from "#tracing/agent-trace-context-codec.js";
import { deriveTaskId } from "#tasks/task-id.js";
import { AgentTraceSpanProcessor } from "#tracing/agent-trace-span-processor.js";

const anchor = {
  attemptIndex: 0,
  callId: "call",
  kind: "tool-call" as const,
  name: "workflow",
  parent: { spanId: "1".repeat(16), traceFlags: 1, traceId: "2".repeat(32) },
  rootSessionId: "session",
  sessionId: "session",
  spanId: "3".repeat(16),
  startTimeMs: 1,
  stepIndex: 0,
  turnId: "turn",
};

describe("trace retention by live work", () => {
  it("does not turn a task-index compatibility problem into an execution failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = new ContextContainer();
    contextStorage.run(context, () =>
      new ContextAgentTraceStateStore().setActionAnchor("key", anchor),
    );
    const before = serializeContext(context);
    expect(() =>
      pruneAgentTraceState(context, "session", { "eve.tasks": { version: 1, tasks: [] } }),
    ).not.toThrow();
    expect(serializeContext(context)).toEqual(before);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not reconcile trace ownership"),
      { error: expect.objectContaining({ message: expect.any(String) }) },
    );
    warn.mockRestore();
  });

  it("does not accumulate anchors across 1000 completed turns", () => {
    const context = new ContextContainer();
    contextStorage.run(context, () => {
      const store = new ContextAgentTraceStateStore();
      for (let index = 0; index < 1000; index++) {
        store.setActionAnchor(`key-${index}`, {
          ...anchor,
          callId: `call-${index}`,
          turnId: `turn-${index}`,
        });
        pruneAgentTraceState(context, "session", undefined);
      }
    });
    expect(serializeContext(context)[AGENT_TRACE_CONTEXT_KEY]).toMatchObject({ actionAnchors: {} });
  });

  it("keeps background anchors until their recorded task finishes", () => {
    const context = new ContextContainer();
    contextStorage.run(context, () =>
      new ContextAgentTraceStateStore().setActionAnchor("key", anchor),
    );
    const task = {
      taskId: deriveTaskId({ callId: "call", parentSessionId: "session", parentTurnId: "turn" }),
      taskRunId: "task-run",
      taskInboxToken: "task-token",
      createdByTurnId: "turn",
      metadata: { kind: "tool", name: "workflow" },
    };
    pruneAgentTraceState(context, "session", { "eve.tasks": { version: 2, tasks: [task] } });
    expect(serializeContext(context)[AGENT_TRACE_CONTEXT_KEY]).toMatchObject({
      actionAnchors: { key: anchor },
    });
    pruneAgentTraceState(context, "session", {
      "eve.tasks": {
        version: 2,
        tasks: [
          {
            ...task,
            terminalView: {
              taskId: task.taskId,
              metadata: task.metadata,
              status: "completed",
              lastOutput: { type: "result", data: "done" },
            },
          },
        ],
      },
    });
    expect(serializeContext(context)[AGENT_TRACE_CONTEXT_KEY]).toMatchObject({ actionAnchors: {} });
  });

  it("unpins completed activation traces only after the writer flushes", async () => {
    const processor = new AgentTraceSpanProcessor([]);
    for (let index = 0; index < 1000; index++) {
      const span = {
        name: "invoke_agent test",
        attributes: {
          "gen_ai.conversation.id": "session",
          "agent.turn.id": `turn-${index}`,
          "gen_ai.operation.name": "invoke_agent",
        },
        spanContext: () => ({ traceId: `trace-${index}` }),
      };
      processor.onStart(span, {});
      processor.onEnd(span);
      expect(processor.activeTraceIds().has(`trace-${index}`)).toBe(true);
      await processor.forceFlush();
      processor.releaseCompletedTraces();
      expect(processor.activeTraceIds().size).toBe(0);
    }
  });
});
