import { describe, expect, it } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import {
  ContextAgentTraceStateStore,
  pruneAgentTraceState,
} from "#tracing/agent-trace-context-store.js";
import { AGENT_TRACE_CONTEXT_KEY } from "#tracing/agent-trace-context-codec.js";
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

  it("keeps an anchor while its workflow tool run is waiting", () => {
    const context = new ContextContainer();
    contextStorage.run(context, () =>
      new ContextAgentTraceStateStore().setActionAnchor("key", anchor),
    );
    const run = {
      callId: "call",
      toolName: "workflow",
      lifetime: "turn" as const,
      origin: { turnId: "turn", stepIndex: 0 },
      address: { runId: "workflow-run", hookToken: "workflow-token" },
    };
    pruneAgentTraceState(context, "session", {
      "eve.workflowTool": { version: 3, runs: [run] },
    });
    expect(serializeContext(context)[AGENT_TRACE_CONTEXT_KEY]).toMatchObject({
      actionAnchors: { key: anchor },
    });
    pruneAgentTraceState(context, "session", undefined);
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
