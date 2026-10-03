import type { TraceLink, TraceReference } from "#tracing/lib/index.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import type { OperationFacts } from "#tracing/lib/index.js";
export function traceSessionIdOf(scope: {
  readonly traceSessionId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
}): string {
  return scope.traceSessionId ?? scope.rootSessionId ?? scope.sessionId;
}

export function checkpointContent(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  // Historical checkpoints contain truncated JSON; omit payloads, not the operation.
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

interface EveOperationFacts {
  readonly sessionId: string;
  readonly rootSessionId?: string;
  readonly traceSessionId?: string;
  readonly turnId: string;
  readonly frameworkVersion: string;
  readonly agentName?: string;
  readonly functionId?: string;
  readonly reference?: TraceReference;
  readonly parent?: TraceReference;
  readonly startTimeMs?: number;
  readonly stepIndex?: number;
  readonly attemptIndex?: number;
  readonly links?: readonly TraceLink[];
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
}

export function eveOperationInput(
  input: EveOperationFacts,
  key: string,
  executionContext?: import("#tracing/lib/index.js").ExecutionContext,
): OperationFacts {
  return {
    identity: {
      conversationId: resolveConversationId(input.rootSessionId ?? input.sessionId),
      runId: input.sessionId,
      turnId: input.turnId,
      agentName: input.agentName ?? input.functionId,
      framework: { name: "eve", version: input.frameworkVersion },
    },
    capture: {
      emit: ((input.reference ?? input.parent)?.traceFlags ?? 1) !== 0,
      recordInputs: true,
      recordOutputs: true,
    },
    attempt: { index: input.stepIndex ?? 0, attempt: input.attemptIndex ?? 0 },
    operationId: key,
    reference: input.reference,
    parent: input.parent,
    startTimeMs: input.startTimeMs,
    links: input.links,
    attributes: {
      "agent.trace.content.input": input.content?.recordInputs,
      "agent.trace.content.output": input.content?.recordOutputs,
    },
    context: executionContext,
  };
}
