import type { Runtime } from "#channel/types.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { executeTurnStepOperation } from "#internal/loops/turn-step-operation.js";
import type { TurnStepResult } from "#internal/loops/types.js";
import type { TimedHandleMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { serializeDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import type { TemporalLoopActivities, TemporalLoopTurnStepInput } from "./contracts.js";
import { TemporalLoopService } from "./service.js";

/** Binds eve operations and the local event service to Temporal Activities. */
export function createTemporalLoopActivities(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
  readonly service: TemporalLoopService;
}): TemporalLoopActivities {
  return {
    async createSession(activityInput): Promise<{ readonly state: DurableSessionState }> {
      try {
        return await createSessionStep({
          compiledArtifactsSource: serializeDurableCompiledArtifactsSource(
            input.compiledArtifactsSource,
          ),
          continuationToken: activityInput.continuationToken,
          inheritedLimits: activityInput.limits,
          nodeId: input.nodeId,
          sessionId: activityInput.sessionId,
        });
      } catch (error) {
        input.service.fail(activityInput.sessionId, error);
        throw error;
      }
    },

    async executeTurnStep(activityInput): Promise<TurnStepResult> {
      try {
        let emissionOrdinal = 0;
        const parentWritable = new WritableStream<Uint8Array>({
          write(encoded) {
            const event = JSON.parse(
              new TextDecoder().decode(encoded).trim(),
            ) as TimedHandleMessageStreamEvent;
            input.service.appendEvent(activityInput.sessionId, {
              encoded,
              event,
              publicationKey: createPublicationKey(activityInput, emissionOrdinal++),
            });
          },
        });
        return await executeTurnStepOperation({
          callbackBaseUrl: undefined,
          createRuntime: unsupportedChildRuntime,
          durableSession: await readDurableSession(activityInput.sessionState),
          input: activityInput.input,
          parentWritable,
          serializedContext: activityInput.serializedContext,
          sessionState: activityInput.sessionState,
          writeEveAttributes: undefined,
        });
      } catch (error) {
        input.service.fail(activityInput.sessionId, error);
        throw error;
      }
    },

    async rekeySession(activityInput): Promise<void> {
      input.service.rekey(activityInput);
    },

    async settleSession(activityInput): Promise<void> {
      input.service.settle(activityInput.sessionId);
    },
  };
}

function unsupportedChildRuntime(): Runtime {
  throw new Error("The Temporal loop implementation does not support delegated child runtimes.");
}

function createPublicationKey(input: TemporalLoopTurnStepInput, emissionOrdinal: number): string {
  return [
    input.sessionId,
    "turn",
    String(input.turnOrdinal),
    "step",
    String(input.stepOrdinal),
    "event",
    String(emissionOrdinal),
  ].join(":");
}
