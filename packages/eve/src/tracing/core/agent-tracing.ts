import { createTraceEngine, type TraceOperation } from "#tracing/core/engine.js";
import {
  frameworkAttributes,
  identityAttributes,
  namingAttributes,
} from "#tracing/core/attributes.js";
import type {
  Attributes,
  CaptureDecision,
  FrameworkIdentity,
  RunIdentity,
  TraceBackend,
  TraceLink,
  TraceReference,
} from "#tracing/core/types.js";
import { createAgentOperations } from "#tracing/core/operations.js";
import type { ContentSerializer } from "#tracing/core/model.js";

export interface TurnInput extends RunIdentity {
  readonly sequence: number;
  readonly caller?: TraceReference;
  readonly request?: TraceReference;
  readonly signal?: AbortSignal;
  readonly metadata?: Attributes;
  readonly activation?: ActivationMetadata;
}

export interface ActivationMetadata {
  readonly audience?: "public" | "private" | "unknown";
  readonly channelKind?: string;
  readonly channelName?: string;
  readonly sessionOrigin?: "channel" | "schedule";
  readonly sessionTitle?: string;
  readonly scheduleId?: string;
  readonly subagentName?: string;
  readonly parentCallId?: string;
  readonly parentRunId?: string;
  readonly currentPrincipal?: { readonly id?: string; readonly type: string };
  readonly initiatorPrincipal?: { readonly id?: string; readonly type: string };
  readonly delivery?: {
    readonly id: string;
    readonly input?: unknown;
    readonly requestId?: string;
  };
}

export interface TurnScope {
  readonly activation: TraceOperation;
  readonly identity: RunIdentity;
  readonly agentName: string;
  readonly framework: FrameworkIdentity;
  readonly capture: CaptureDecision;
  readonly engine: ReturnType<typeof createTraceEngine>;
  readonly operations: ReturnType<typeof createAgentOperations>;
  nextStep(): number;
  own(operation: TraceOperation): void;
  addUsage(inputTokens?: number, outputTokens?: number): void;
  cancel(): void;
}

export function createAgentTracing(input: {
  readonly agentName: string;
  readonly framework: FrameworkIdentity;
  readonly backend: TraceBackend;
  readonly serializer: ContentSerializer;
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
  readonly diagnostic?: (code: string) => void;
}) {
  return {
    async turn<T>(turn: TurnInput, execute: (scope: TurnScope) => Promise<T>): Promise<T> {
      const engine = createTraceEngine(input);
      const capture: CaptureDecision = {
        emit: turn.caller === undefined || (turn.caller.traceFlags & 1) !== 0,
        recordInputs: input.content?.recordInputs ?? false,
        recordOutputs: input.content?.recordOutputs ?? false,
      };
      const links: TraceLink[] = [];
      if (turn.sequence === 0 && turn.caller !== undefined)
        links.push({ context: turn.caller, relationship: "agent.dispatch" });
      if (turn.request !== undefined)
        links.push({ context: turn.request, relationship: "channel.request" });
      const name = `invoke_agent ${input.agentName}`;
      const metadata = turn.activation;
      const activation = engine.start(
        {
          type: "activation",
          operationId: turn.turnId,
          name,
          kind: "INTERNAL",
          root: true,
          links,
          attributes: {
            ...safeMetadata(turn.metadata),
            ...identityAttributes(turn),
            ...frameworkAttributes(input.framework),
            ...namingAttributes(name, "invoke_agent"),
            "agent.name": input.agentName,
            "gen_ai.agent.name": input.agentName,
            "gen_ai.operation.name": "invoke_agent",
            "agent.turn.id": turn.turnId,
            "agent.turn.sequence": turn.sequence,
            "agent.run.type": turn.caller === undefined ? "session" : "subagent",
            "agent.trace.content.input": capture.recordInputs,
            "agent.trace.content.output": capture.recordOutputs,
            "agent.channel.audience": metadata?.audience,
            "agent.channel.kind": metadata?.channelKind,
            "agent.channel.name": metadata?.channelName,
            "agent.session.origin": metadata?.sessionOrigin,
            "agent.session.title": capture.recordInputs ? metadata?.sessionTitle : undefined,
            "agent.schedule.id": metadata?.scheduleId,
            "agent.subagent.name": metadata?.subagentName,
            "agent.parent_call.id": metadata?.parentCallId,
            "agent.parent_run.id": metadata?.parentRunId,
            "agent.principal.current.type": metadata?.currentPrincipal?.type,
            "agent.principal.initiator.type": metadata?.initiatorPrincipal?.type,
            "agent.principal.current.id": capture.recordInputs
              ? metadata?.currentPrincipal?.id
              : undefined,
            "agent.principal.initiator.id": capture.recordInputs
              ? metadata?.initiatorPrincipal?.id
              : undefined,
            "agent.channel.delivery.id": metadata?.delivery?.id,
            "agent.channel.request.id": metadata?.delivery?.requestId,
            "agent.channel.delivery.input": capture.recordInputs
              ? input.serializer.json(metadata?.delivery?.input)
              : undefined,
          },
        },
        capture,
      );
      const operationsApi = createAgentOperations({ ...input, identity: turn, capture });
      const operations = new Set<TraceOperation>();
      let nextStep = 0;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let cancelled = turn.signal?.aborted ?? false;
      let terminalError: unknown;
      const cancel = () => {
        cancelled = true;
      };
      turn.signal?.addEventListener("abort", cancel, { once: true });
      activation.addEvent("turn.started");
      try {
        const result = await activation.run(() =>
          execute({
            activation,
            identity: turn,
            agentName: input.agentName,
            framework: input.framework,
            capture,
            engine,
            operations: operationsApi,
            nextStep: () => nextStep++,
            own(operation) {
              if (operations.size >= 10_000) {
                for (const previous of operations)
                  if (previous.finished) operations.delete(previous);
                if (operations.size >= 10_000) {
                  operation.end();
                  try {
                    input.diagnostic?.("agent.tracing.operation_limit");
                  } catch {}
                  return;
                }
              }
              operations.add(operation);
            },
            addUsage(usedInput, usedOutput) {
              if (usedInput !== undefined) inputTokens = (inputTokens ?? 0) + usedInput;
              if (usedOutput !== undefined) outputTokens = (outputTokens ?? 0) + usedOutput;
            },
            cancel,
          }),
        );
        activation.setAttribute("agent.turn.outcome", cancelled ? "cancelled" : "completed");
        activation.addEvent(cancelled ? "turn.cancelled" : "turn.completed");
        return result;
      } catch (error) {
        terminalError = error;
        activation.setAttribute("agent.turn.outcome", cancelled ? "cancelled" : "failed");
        activation.addEvent(cancelled ? "turn.cancelled" : "turn.failed");
        if (!cancelled) activation.fail(error);
        throw error;
      } finally {
        turn.signal?.removeEventListener("abort", cancel);
        for (const operation of [...operations].reverse()) {
          if (!operation.finished && terminalError !== undefined && !cancelled)
            operation.fail(terminalError);
          operation.end();
        }
        if (inputTokens !== undefined) {
          activation.setAttribute("agent.usage.input_tokens", inputTokens);
          activation.setAttribute("gen_ai.usage.input_tokens", inputTokens);
        }
        if (outputTokens !== undefined) {
          activation.setAttribute("agent.usage.output_tokens", outputTokens);
          activation.setAttribute("gen_ai.usage.output_tokens", outputTokens);
        }
        activation.end();
      }
    },
  };
}

function safeMetadata(metadata: Attributes | undefined): Attributes {
  const output: Record<string, Attributes[string]> = {};
  for (const [key, value] of Object.entries(metadata ?? {}).slice(0, 256)) {
    if (
      !key.startsWith("agent.") &&
      !key.startsWith("gen_ai.") &&
      !key.startsWith("eve.") &&
      !key.startsWith("vercel.")
    )
      output[key] = value;
  }
  return output;
}
