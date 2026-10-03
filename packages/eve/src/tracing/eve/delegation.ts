import { currentAgentHandoff, withAgentHandoff, type AgentHandoff } from "#tracing/lib/index.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { SessionParent, SessionTraceContext } from "#channel/types.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import { intersectInstrumentationDecisions } from "#shared/instrumentation-decision.js";
import { readConversationBaggage } from "#tracing/eve/conversation-context.js";

const HANDOFF_BYTES = 8192;
const HEADER = "x-agent-tracing";
const encoder = new TextEncoder();
function isHexId(value: unknown, length: number): boolean {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[a-f0-9]+$/u.test(value) &&
    !/^0+$/u.test(value)
  );
}
function receiveAgentTrace<T>(
  headers: Headers,
  trusted: (handoff: AgentHandoff) => boolean,
  execute: (handoff?: AgentHandoff) => T,
): T {
  const encoded = headers.get(HEADER);
  if (
    encoded === null ||
    encoded.length > HANDOFF_BYTES ||
    encoder.encode(encoded).length > HANDOFF_BYTES
  )
    return execute();
  let decoded: AgentHandoff | undefined;
  try {
    const handoff = JSON.parse(encoded) as AgentHandoff;
    if (
      handoff !== null &&
      typeof handoff === "object" &&
      [handoff.conversationId, handoff.parentRunId, handoff.parentCallId, handoff.agentName].every(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 1024,
      ) &&
      isHexId(handoff.caller.traceId, 32) &&
      isHexId(handoff.caller.spanId, 16) &&
      [0, 1].includes(handoff.caller.traceFlags) &&
      (handoff.caller.tracestate === undefined ||
        (typeof handoff.caller.tracestate === "string" &&
          handoff.caller.tracestate.length <= 512)) &&
      [handoff.capture.emit, handoff.capture.recordInputs, handoff.capture.recordOutputs].every(
        (value) => typeof value === "boolean",
      ) &&
      trusted(handoff)
    )
      decoded = handoff;
  } catch {}
  if (decoded === undefined) return execute();
  const emit = decoded.capture.emit && decoded.caller.traceFlags === 1;
  const accepted = {
    ...decoded,
    capture: {
      emit,
      recordInputs: emit && decoded.capture.recordInputs,
      recordOutputs: emit && decoded.capture.recordOutputs,
    },
  };
  return withAgentHandoff(accepted, () => execute(accepted));
}

export const agentDelegation = {
  fetch: ((request, init) => {
    const handoff = currentAgentHandoff();
    if (handoff === undefined) return globalThis.fetch(request, init);
    const encoded = JSON.stringify(handoff);
    if (encoder.encode(encoded).length > HANDOFF_BYTES) return globalThis.fetch(request, init);
    const headers = new Headers(
      init?.headers ?? (request instanceof Request ? request.headers : undefined),
    );
    headers.set(HEADER, encoded);
    return globalThis.fetch(request, { ...init, headers, redirect: "error" });
  }) as typeof fetch,
  resume<T>(
    input: { context: Pick<AgentSessionContext, "trace" | "parent">; agentName: string },
    execute: () => T,
  ): T {
    const { context } = input;
    const caller = context.trace.parentTraceContext;
    if (caller === undefined) return execute();
    const decision = caller.decision;
    return withAgentHandoff(
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
    return receiveAgentTrace(
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
