import { createAgentDelegationTransport } from "#tracing/lib/delegation.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { SessionParent, SessionTraceContext } from "#channel/types.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import { intersectInstrumentationDecisions } from "#shared/instrumentation-decision.js";
import { readConversationBaggage } from "#tracing/eve/conversation-context.js";

const transport = createAgentDelegationTransport();

export const agentDelegation = {
  fetch: transport.fetch,
  resume<T>(
    input: { context: Pick<AgentSessionContext, "trace" | "parent">; agentName: string },
    execute: () => T,
  ): T {
    const { context } = input;
    const caller = context.trace.parentTraceContext;
    if (caller === undefined) return execute();
    const decision = caller.decision;
    return transport.resume(
      {
        caller,
        conversationId:
          context.trace.conversationId ?? resolveConversationId(context.parent.rootSessionId),
        parentRunId: context.parent.sessionId,
        parentCallId: context.parent.callId,
        agentName: input.agentName,
        capture: {
          emit: caller.traceFlags === 1 && decision?.action !== "drop",
          recordInputs: decision?.action === "record" && decision.recordInputs,
          recordOutputs: decision?.action === "record" && decision.recordOutputs,
        },
      },
      execute,
    );
  },
  receive<T>(
    input: {
      headers: Headers;
      delegated: boolean;
      trusted: boolean;
      parent?: SessionParent;
      callerTrace?: SessionTraceContext;
      parentTraceContext?: SessionTraceContext;
    },
    execute: (context: { conversationId?: string; parentTraceContext?: SessionTraceContext }) => T,
  ): T {
    return transport.receive(
      input.headers,
      (handoff) =>
        input.delegated &&
        input.trusted &&
        input.parent !== undefined &&
        handoff.parentRunId === input.parent.sessionId &&
        handoff.parentCallId === input.parent.callId &&
        input.callerTrace?.traceId === handoff.caller.traceId &&
        input.callerTrace.spanId === handoff.caller.spanId,
      (handoff) => {
        const parentTrace = input.parentTraceContext;
        const decision = handoff?.capture.emit
          ? {
              action: "record" as const,
              recordInputs: handoff.capture.recordInputs,
              recordOutputs: handoff.capture.recordOutputs,
            }
          : { action: "drop" as const };
        const inheritedTrace =
          handoff === undefined || parentTrace === undefined
            ? parentTrace
            : {
                ...parentTrace,
                decision:
                  parentTrace.decision === undefined
                    ? decision
                    : intersectInstrumentationDecisions(parentTrace.decision, decision),
                traceFlags: handoff.capture.emit ? parentTrace.traceFlags : 0,
              };
        return execute({
          conversationId: input.delegated
            ? (handoff?.conversationId ?? readConversationBaggage(input.headers.get("baggage")))
            : undefined,
          parentTraceContext: inheritedTrace,
        });
      },
    );
  },
};
