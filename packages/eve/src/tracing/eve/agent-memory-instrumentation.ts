import { ROOT_CONTEXT, context, trace } from "@opentelemetry/api";
import { contextStorage } from "#context/container.js";
import { SessionTraceSeedKey } from "#context/keys.js";
import type {
  InstrumentationMemoryExecutionOperation,
  MemoryInstrumentationResult,
} from "#instrumentation/memory.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import {
  applyLiveDeliveryAudienceCeiling,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";
import type { ConversationEnvironment } from "#shared/conversation-context.js";
import type { AgentTraceStateStore } from "#tracing/eve/agent-trace-state.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import { eveTurnIdentity } from "#tracing/eve/operation-input.js";
import { type AgentTracing } from "#tracing/lib/index.js";
import { activeTraceOperation } from "#tracing/lib/otel.js";

export function createAgentMemoryInstrumentation(input: {
  tracing: AgentTracing;
  environment: ConversationEnvironment;
  recordOutputs?: boolean;
  stateStore: AgentTraceStateStore;
}) {
  return {
    async runInContext<T>(
      operation: InstrumentationMemoryExecutionOperation,
      execute: () => PromiseLike<T>,
    ): Promise<T> {
      const session = await input.stateStore.get("session", operation.sessionId);
      const turn =
        operation.turnId === undefined
          ? undefined
          : await input.stateStore.get(
              "turn",
              JSON.stringify([operation.sessionId, operation.turnId]),
            );
      const active = activeTraceOperation();
      const reference = active?.reference ?? turn?.context ?? session?.context;
      if (reference === undefined) return await execute();
      const host =
        active === undefined
          ? withChannelAudience(
              trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(reference)),
              session?.channelAudience,
            )
          : context.active();
      const seed = resolveForwardedTraceSeed(contextStorage.getStore()?.get(SessionTraceSeedKey));
      const decision = seed?.decision ?? session?.decision;
      const effective =
        decision === undefined
          ? undefined
          : applyLiveDeliveryAudienceCeiling(
              decision,
              normalizeChannelAudience(session?.channelAudience),
              seed?.forwardedTracePolicy,
              input.environment,
            );
      const capture = {
        emit: (reference.traceFlags & 1) !== 0,
        recordInputs: effective?.action === "record" && effective.recordInputs,
        recordOutputs:
          input.recordOutputs === true && effective?.action === "record" && effective.recordOutputs,
      };
      const data = {
        identity: eveTurnIdentity({ ...operation, turnId: operation.turnId ?? "" }),
        parent: reference,
        context: host,
        capture,
        phase: operation.phase,
        slot: operation.slot,
        storeId: operation.storeId,
        describe(value: T) {
          const result = value as MemoryInstrumentationResult<unknown>;
          return { recordCount: result.recordCount, records: result.outputRecords };
        },
      };
      const memory = input.tracing.memory;
      return operation.operationName === "search_memory"
        ? await memory.search(data, execute)
        : await memory.write(data, execute);
    },
  };
}
