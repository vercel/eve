import type { ContextContainer } from "#context/container.js";
import { HandleEventKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import {
  type AgentLoopCheckpoint,
  writeAgentLoopCheckpoint,
} from "#execution/agent-loop-checkpoint.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import type { DurableTransition } from "#execution/next-driver-action.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { runBackgroundStep } from "#execution/tasks/parent/tool-execution.js";
import { parseJsonObject } from "#shared/json.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { HandleEventFn, HarnessSession, StepResult } from "#harness/types.js";

export class AgentLoopBatch {
  private readonly abortSignal: AbortSignal | undefined;
  private readonly ctx: ContextContainer;
  private readonly initialSessionState: AgentLoopCheckpoint["sessionState"];
  private readonly initialSerializedContext: Record<string, unknown>;
  private latestSession: HarnessSession;
  private checkpoint: AgentLoopCheckpoint | undefined;
  completedSteps: number;

  constructor(
    abortSignal: AbortSignal | undefined,
    ctx: ContextContainer,
    initialSession: HarnessSession,
    initialSessionState: AgentLoopCheckpoint["sessionState"],
    initialSerializedContext: Record<string, unknown>,
    checkpoint: AgentLoopCheckpoint | undefined,
  ) {
    this.abortSignal = abortSignal;
    this.ctx = ctx;
    this.initialSessionState = initialSessionState;
    this.initialSerializedContext = initialSerializedContext;
    this.latestSession = initialSession;
    this.checkpoint = checkpoint;
    this.completedSteps = checkpoint?.completedSteps ?? 0;
  }

  cancellationTransition(): DurableTransition | undefined {
    return this.checkpoint === undefined
      ? undefined
      : {
          serializedContext: this.checkpoint.serializedContext,
          sessionState: this.checkpoint.sessionState,
        };
  }

  checkpointTransition(): DurableTransition {
    return this.checkpoint === undefined
      ? {
          serializedContext: this.initialSerializedContext,
          sessionState: this.initialSessionState,
        }
      : {
          serializedContext: this.checkpoint.serializedContext,
          sessionState: this.checkpoint.sessionState,
        };
  }

  checkpointSession(): HarnessSession {
    return this.latestSession;
  }

  checkpointSessionState(): AgentLoopCheckpoint["sessionState"] | undefined {
    return this.checkpoint?.sessionState;
  }

  checkpointSerializedContext(): Record<string, unknown> {
    return this.checkpoint?.serializedContext ?? this.initialSerializedContext;
  }

  async commitContinuation(): Promise<void> {
    this.checkpoint = await writeAgentLoopCheckpoint({
      completedSteps: this.completedSteps,
      serializedContext: parseJsonObject(serializeContext(this.ctx)),
      sessionState: createDurableSessionState({ session: this.latestSession }),
    });
  }

  async run(
    session: HarnessSession,
    handleEvent: HandleEventFn,
    callback: (enrichedSession: HarnessSession) => Promise<StepResult>,
  ): Promise<StepResult> {
    throwIfTurnAborted(this.abortSignal);
    let result = await runBackgroundStep(this.ctx, session, async (enrichedSession) => {
      this.ctx.setVirtualContext(HandleEventKey, handleEvent);
      return callback(enrichedSession);
    });
    if (result.backgroundTasks === undefined) throwIfTurnAborted(this.abortSignal);

    result = {
      ...result,
      session: reconcileSessionContinuationToken(this.ctx, result.session),
    };
    this.latestSession = result.session;
    this.completedSteps += 1;
    return result;
  }
}
