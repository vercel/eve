import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionTraceSeedKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { resolveToolCallAgentTrace } from "#tracing/agent-invocation-coordinator.js";
import { ContextAgentTraceStateStore } from "#tracing/agent-trace-context-store.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { ConversationContext } from "#shared/conversation-context.js";

const actionKey = actionIdempotencyKey("session-1", "turn-1", "workflow");
const conversation: ConversationContext = {
  audience: "private",
  channel: { kind: "http" },
  environment: "production",
  principalType: "anonymous",
};

describe("resolveToolCallAgentTrace", () => {
  it.each([true, false])(
    "parents to the call's action span, or its turn, capped to the live audience (recorded: %s)",
    async (recorded) => {
      const context = new ContextContainer();
      const action = workflowAction();
      context.set(SessionTraceSeedKey, {
        ...action.parent,
        decision: { action: "record", recordInputs: true, recordOutputs: true },
        forwardedTracePolicy: {
          originAudience: "public",
          ceiling: { recordInputs: true, recordOutputs: true },
        },
      });
      await contextStorage.run(context, () => {
        const store = new ContextAgentTraceStateStore();
        store.setTurn("session-1", "turn-1", {
          context: action.parent,
          rootSessionId: "session-1",
          sequence: 0,
          startTimeMs: 1,
        });
        if (recorded) store.setActionAnchor(actionKey, action);
      });

      const dispatch = resolveToolCallAgentTrace({
        callId: "workflow",
        conversation,
        serializedContext: await serializeContext(context),
        sessionId: "session-1",
        turnId: "turn-1",
      });

      expect(dispatch.parentTraceContext).toMatchObject({
        ...action.parent,
        spanId: recorded ? action.spanId : action.parent.spanId,
        decision: { action: "record", recordInputs: false, recordOutputs: false },
      });
      expect(dispatch.originAudience).toBe("public");
    },
  );
});

function workflowAction() {
  return {
    attemptIndex: 0,
    callId: "workflow",
    channelAudience: "private" as const,
    isWorkflowTool: true,
    kind: "tool-call" as const,
    name: "coordinate",
    parent: {
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    },
    rootSessionId: "session-1",
    sessionId: "session-1",
    spanId: "3".repeat(16),
    startTimeMs: 1,
    stepIndex: 0,
    turnId: "turn-1",
  };
}
