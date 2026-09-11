import {
  createHook,
  type Hook,
  getWorkflowMetadata,
  getWritable,
} from "#compiled/@workflow/core/index.js";

import type {
  DeliverHookPayload,
  DeliverPayload,
  RunInput,
  SessionCapabilities,
} from "#channel/types.js";
import { readChannelRequestId, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import {
  createSafeOuterWorkflowError,
  type CrashCleanupState,
  hasDelegatedCallerContext,
  resolveCallerForCrash,
} from "#execution/workflow-entry-crash.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import type { RunMode } from "#shared/run-mode.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import {
  bindTurnCallerContextStep,
  notifyCancelledTaskCallerStep,
  notifyDelegatedParentStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#subagents/parent-notification.js";
import { createDelegatedSubagentErrorResult } from "#subagents/parent-result.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { nextTurnDelivery, type NextTurnInstruction } from "#execution/parked-delivery-wait.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { SessionExecution } from "#execution/session-execution.js";
import type { TurnOutcome, TurnStepPayload } from "#execution/turn-step.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { fireSessionCallbackStep } from "#subagents/callback-step.js";
import { finalizeDone, finalizeExpiredSession } from "#execution/workflow-entry-finalization.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  createSessionInbox,
  claimSessionHooks,
  type SessionInboxHandle,
  type SessionInboxPayload,
} from "#execution/session-inbox/inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session-timeout.js";
import { createSessionTimeoutControl } from "#execution/session-timeout-control.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";
import { SESSION_INBOX_CONTEXT_KEY } from "#execution/session-inbox/address.js";
import { SessionHandoff } from "#execution/session-handoff.js";
import {
  signalSessionAnchorStep,
  signalSessionOwnerActivationStep,
} from "#execution/session-handoff-steps.js";
import { validateSessionCheckpointStep } from "#execution/session-checkpoint-validation-step.js";

// workflow-entry.ts is the durable workflow body — the bundler rejects
// node built-ins here, so `internal/logging.ts` cannot be imported.
// Error logging happens inside `emitTerminalSessionFailureStep`.

import type {
  InitialWorkflowEntryInput,
  WorkflowEntryInput,
  WorkflowEntryResult,
} from "#execution/workflow-entry-input.js";

type SessionLoopOutcome =
  | {
      readonly kind: "expired";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "result";
      readonly result: WorkflowEntryResult;
    }
  | {
      readonly kind: "transferred";
    };

/**
 * Long-lived workflow entrypoint. Handles both root sessions and
 * delegated child sessions: root sessions expose only parent
 * control-plane events; delegated children publish their full progress
 * on a child stream and resume the parked parent with a
 * `subagent-result` on completion.
 *
 * The current owner directly executes every turn. An idle owner can transfer
 * its settled checkpoint and hooks to an exact successor deployment while the
 * original run remains parked as the public stream anchor.
 */
export async function workflowEntry(input: WorkflowEntryInput): Promise<WorkflowEntryResult> {
  "use workflow";

  const { workflowRunId: ownerRunId, workflowStartedAt } = getWorkflowMetadata();
  const isInitialOwner = input.kind === "initial";
  const sessionId = isInitialOwner ? ownerRunId : input.checkpoint.ownership.sessionId;
  const anchorRunId = isInitialOwner ? ownerRunId : input.checkpoint.ownership.anchorRunId;
  const serializedContext = isInitialOwner
    ? input.serializedContext
    : { ...input.checkpoint.serializedContext };
  const continuationToken = isInitialOwner
    ? (serializedContext["eve.continuationToken"] as string) || ""
    : input.checkpoint.sessionState.continuationToken;
  const mode = isInitialOwner ? (serializedContext["eve.mode"] as RunMode) : input.checkpoint.mode;
  const capabilities = isInitialOwner
    ? (serializedContext["eve.capabilities"] as SessionCapabilities | undefined)
    : input.checkpoint.capabilities;
  const retention = isInitialOwner ? input.retention : input.checkpoint.retention;
  const sessionTimeoutDeadline = isInitialOwner
    ? input.sessionTimeoutMs === false
      ? undefined
      : new Date(
          workflowStartedAt.getTime() + (input.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS),
        )
    : input.checkpoint.sessionTimeoutDeadline;
  const anchorToken = isInitialOwner ? `${sessionId}:anchor` : input.checkpoint.anchorToken;

  serializedContext["eve.sessionId"] = sessionId;
  serializedContext[SESSION_INBOX_CONTEXT_KEY] = { sessionId };

  const sessionWritable = isInitialOwner ? getWritable<Uint8Array>() : input.parentWritable;
  const crashCleanupState: CrashCleanupState = {
    caller: undefined,
    callerResolved: false,
    lastSessionState: undefined,
    serializedContext,
    terminalEmitted: false,
  };
  let anchor: Hook<WorkflowEntryResult> | undefined;
  const ensureAnchor = async (): Promise<void> => {
    if (!isInitialOwner || anchor !== undefined) return;
    anchor = createHook<WorkflowEntryResult>({ token: anchorToken });
    await claimHookOwnership(anchor);
  };
  let activationConfirmed = isInitialOwner;
  let failedActivationPayloads: readonly SessionInboxPayload[] = [];

  try {
    const commandInbox = createSessionInbox(sessionId);
    const sessionHookTokens = isInitialOwner
      ? [sessionCommandHookToken(sessionId)]
      : input.checkpoint.hooks.session;
    const stableCommandToken = sessionHookTokens[0];
    if (stableCommandToken === undefined) {
      throw new Error("Session owner requires a stable inbox hook.");
    }
    let sessionState: DurableSessionState;
    let outcome: SessionLoopOutcome;
    try {
      if (isInitialOwner) {
        const serializedBundle = serializedContext["eve.bundle"] as {
          source: DurableCompiledArtifactsSource;
          nodeId?: string;
        };
        const dynamicSubagentAgentConfig = serializedContext["eve.dynamicSubagentAgentConfig"] as
          | DynamicSubagentAgentConfig
          | undefined;
        const [sessionCreation, stableClaim, aliasClaim] = await Promise.allSettled([
          createSessionStep({
            compiledArtifactsSource: serializedBundle.source,
            continuationToken,
            dynamicSubagentAgentConfig,
            inheritedLimits: input.limits,
            nodeId: serializedBundle.nodeId,
            outputSchema: input.input.outputSchema,
            rootSessionId: readRootSessionId(serializedContext),
            sessionId,
            taskId: input.taskId,
          }),
          commandInbox.claimSessionHook(stableCommandToken),
          continuationToken === ""
            ? Promise.resolve()
            : commandInbox.claimSessionHook(continuationToken),
        ]);
        if (sessionCreation.status === "rejected") throw sessionCreation.reason;
        if (stableClaim.status === "rejected") throw stableClaim.reason;
        try {
          if (aliasClaim.status === "rejected") throw aliasClaim.reason;
        } catch (error) {
          if (isHookConflictError(error)) {
            if (
              input.activityCollectorRunId !== undefined ||
              input.continuationConflictCommand !== undefined
            ) {
              await settleContinuationConflictStep({
                activityCollectorRunId: input.activityCollectorRunId,
                command: input.continuationConflictCommand,
                continuationToken,
              });
            }
            return { output: "" };
          }
          throw error;
        }
        sessionState = sessionCreation.value.state;
        crashCleanupState.caller = hasDelegatedCallerContext(serializedContext)
          ? await resolveInitialTurnCallerStep({ serializedContext })
          : undefined;
      } else {
        await validateSessionCheckpointStep({ checkpoint: input.checkpoint });
        await claimSessionHooks(commandInbox, sessionHookTokens);
        sessionState = input.checkpoint.sessionState;
        crashCleanupState.caller = input.checkpoint.caller;
        await signalSessionOwnerActivationStep({
          activation: { kind: "active" },
          token: input.activationToken,
        });
        activationConfirmed = true;
      }

      crashCleanupState.lastSessionState = sessionState;
      crashCleanupState.callerResolved = true;

      outcome = await runSessionLoop({
        anchorRunId,
        anchorToken,
        ensureAnchor,
        capabilities,
        commandInbox,
        sessionWritable,
        initialInput: isInitialOwner
          ? createInitialDelivery(input, serializedContext)
          : input.delivery,
        crashCleanupState,
        mode,
        ownerDeploymentId: input.ownerDeploymentId,
        ownerRunId,
        retention,
        serializedContext,
        sessionState,
        sessionId,
        sessionTimeoutDeadline,
        stableCommandToken,
      });
    } finally {
      if (!activationConfirmed && input.kind === "handoff") {
        failedActivationPayloads = await commandInbox.release();
      } else {
        await commandInbox.dispose();
      }
    }
    if (outcome.kind === "transferred") {
      if (!isInitialOwner) return { output: "" };
      try {
        return await anchor!;
      } finally {
        if (anchor !== undefined) await disposeHook(anchor);
      }
    }
    const result =
      outcome.kind === "result"
        ? outcome.result
        : await finalizeExpiredSession({
            caller: crashCleanupState.caller,
            sessionWritable,
            mode,
            serializedContext: outcome.serializedContext,
            sessionState: outcome.sessionState,
            terminalState: crashCleanupState,
          });
    if (isInitialOwner) {
      if (anchor !== undefined) await disposeHook(anchor);
    } else {
      await signalSessionAnchorStep({ result, token: anchorToken });
    }
    return result;
  } catch (error) {
    if (!activationConfirmed && input.kind === "handoff") {
      await signalSessionOwnerActivationStep({
        activation: {
          error: normalizeSerializableError(error),
          kind: "failed",
          payloads: failedActivationPayloads,
        },
        token: input.activationToken,
      });
      return { output: "" };
    }
    const terminalAlreadyEmitted = crashCleanupState.terminalEmitted;
    // Safety net for failures the tool-loop harness does not already
    // surface as `session.failed` (deserialization, runtime-action
    // throws, adapter `deliver` throws, staging errors, etc.) so the
    // channel still sees a terminal event.
    if (!crashCleanupState.terminalEmitted && crashCleanupState.lastSessionState !== undefined) {
      await terminateChildSessionsStep({
        serializedContext: crashCleanupState.serializedContext,
        sessionState: crashCleanupState.lastSessionState,
      });
    }
    if (!crashCleanupState.terminalEmitted) {
      await emitTerminalSessionFailureStep({
        error: normalizeSerializableError(error),
        parentWritable: sessionWritable,
        serializedContext: crashCleanupState.serializedContext,
        turnId: crashCleanupState.turnId,
      });
      crashCleanupState.terminalEmitted = true;
    }
    if (terminalAlreadyEmitted) throw createSafeOuterWorkflowError();
    if (mode === "task") {
      await fireSessionCallbackStep({
        error: normalizeSerializableError(error),
        serializedContext: crashCleanupState.serializedContext,
        status: "failed",
      });
      await notifyDelegatedParentStep({
        result: createDelegatedSubagentErrorResult(crashCleanupState.serializedContext, error),
        serializedContext: crashCleanupState.serializedContext,
      });
    } else if (crashCleanupState.caller !== undefined || !crashCleanupState.callerResolved) {
      await notifyTurnCallerStep({
        caller: await resolveCallerForCrash(crashCleanupState, crashCleanupState.serializedContext),
        lifecycle: "terminal",
        sessionId,
        settled: { isError: true, output: error },
      });
    }
    if (!isInitialOwner) {
      await signalSessionAnchorStep({ result: { output: "" }, token: anchorToken });
    } else {
      if (anchor !== undefined) await disposeHook(anchor);
    }
    throw createSafeOuterWorkflowError();
  }
}

function createInitialDelivery(
  input: InitialWorkflowEntryInput,
  serializedContext: Record<string, unknown>,
): DeliverHookPayload {
  return {
    deliveryMetadata:
      serializedContext["eve.channelDelivery"] === undefined
        ? undefined
        : [
            {
              ...(serializedContext["eve.channelDelivery"] as NonNullable<RunInput["delivery"]>),
              payloadIndex: 0,
            },
          ],
    kind: "deliver",
    payloads: [
      attachClientContext(
        {
          message: input.input.message,
          context: input.input.context,
          outputSchema: input.input.outputSchema,
        },
        readClientContext(input.input),
      ),
    ],
    requestId: readChannelRequestId(serializedContext),
  };
}
async function runSessionLoop(input: {
  readonly anchorRunId: string;
  readonly anchorToken: string;
  readonly ensureAnchor: () => Promise<void>;
  readonly capabilities?: SessionCapabilities;
  readonly commandInbox: SessionInboxHandle;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly initialInput: DeliverHookPayload;
  readonly crashCleanupState: CrashCleanupState;
  readonly mode: RunMode;
  readonly ownerDeploymentId: string;
  readonly ownerRunId: string;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionId: string;
  readonly sessionTimeoutDeadline?: Date;
  readonly stableCommandToken: string;
}): Promise<SessionLoopOutcome> {
  const commandInbox = input.commandInbox;
  // One payload per exact authorization attempt accumulates across
  // intervening turns. Replaced attempts are pruned at each park.
  const collectedAuthPayloads = new Map<string, DeliverPayload>();
  /**
   * Waits for the next parked-session activity. While an authorization
   * challenge is open (`expected > 0`), callback reads surface through the
   * same single FIFO wait as ordinary session activity — one arrival order,
   * which keeps the wait deterministic under workflow replay — and keep
   * surfacing across wait iterations that produce no parent turn (no-op
   * cancels, fully-routed descendant deliveries). Callbacks accumulate
   * across intervening turns; once every expected challenge has reported,
   * the collected payloads resume the challenge.
   */
  const nextParkedActivity = async (park: {
    readonly expectedAttemptIds: readonly string[];
  }): Promise<
    | { readonly kind: "authorization-resume"; readonly payloads: DeliverPayload[] }
    | Exclude<NextTurnInstruction, { kind: "authorization" | "workflow" }>
  > => {
    const expectedAttemptIds = new Set(park.expectedAttemptIds);
    for (const attemptId of collectedAuthPayloads.keys()) {
      if (!expectedAttemptIds.has(attemptId)) collectedAuthPayloads.delete(attemptId);
    }

    while (true) {
      if (
        expectedAttemptIds.size > 0 &&
        [...expectedAttemptIds].every((attemptId) => collectedAuthPayloads.has(attemptId))
      ) {
        const payloads = [...expectedAttemptIds].map((attemptId) =>
          collectedAuthPayloads.get(attemptId)!,
        );
        collectedAuthPayloads.clear();
        return { kind: "authorization-resume", payloads };
      }

      const next = await nextTurnDelivery({
        awaitAuthorizationCallbacks: expectedAttemptIds.size > 0,
        bufferedDeliveries,
        bufferedSessionControls,
        cancelledTaskIds,
        commandInbox,
        deferDeliveries: input.mode === "task" && expectedAttemptIds.size > 0,
        sessionWritable: input.sessionWritable,
        seenTaskDeliveries,
        stateCursor,
      });
      if (next.kind === "workflow") {
        await execution.handleWorkflowMessage(next.message);
        continue;
      }
      if (next.kind !== "authorization") return next;

      for (const payload of next.payloads) {
        const callback = payload["authorizationCallback"] as
          | { readonly attemptId?: unknown }
          | undefined;
        if (
          typeof callback?.attemptId === "string" &&
          expectedAttemptIds.has(callback.attemptId) &&
          !collectedAuthPayloads.has(callback.attemptId)
        ) {
          collectedAuthPayloads.set(callback.attemptId, payload);
        }
      }
    }
  };
  const bufferedDeliveries: DeliverHookPayload[] = [];
  const bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset"> = [];
  const cancelledTaskIds = new Set<string>();
  const seenTaskDeliveries = new Set<string>();
  const execution = new SessionExecution({
    bufferedDeliveries,
    bufferedSessionControls,
    cancelledTaskIds,
    capabilities: input.capabilities,
    commandInbox,
    mode: input.mode,
    parentWritable: input.sessionWritable,
    serializedContext: input.serializedContext,
    seenTaskDeliveries,
    sessionState: input.sessionState,
  });
  const stateCursor = execution.cursor;
  const sessionTimeout =
    input.sessionTimeoutDeadline === undefined
      ? undefined
      : createSessionTimeoutControl({
          deadline: input.sessionTimeoutDeadline,
          token: input.stableCommandToken,
        });

  let turnIndex = 0;
  const runTurn = async (delivery: TurnStepPayload): Promise<TurnOutcome> => {
    const caller = input.crashCleanupState.caller;
    if (caller?.taskId !== undefined) {
      seenTaskDeliveries.add(caller.taskId);
    }
    const serializedContext =
      caller === undefined
        ? stateCursor.serializedContext
        : await bindTurnCallerContextStep({
            caller,
            serializedContext: stateCursor.serializedContext,
          });
    input.crashCleanupState.turnId = `turn_${String(turnIndex++)}`;
    stateCursor.adoptState({ serializedContext });
    const action = await execution.runTurn(delivery);
    stateCursor.adoptState(action);
    input.crashCleanupState.lastSessionState = stateCursor.sessionState;
    input.crashCleanupState.serializedContext = stateCursor.serializedContext;
    return action;
  };

  try {
    const initialTurn = runTurn(input.initialInput);
    const [actionResult, timerResult] = await Promise.allSettled([
      initialTurn,
      sessionTimeout?.start(),
    ]);
    if (timerResult.status === "rejected") throw timerResult.reason;
    if (actionResult.status === "rejected") throw actionResult.reason;
    let action: TurnOutcome = actionResult.value;

    while (true) {
      if (action.kind === "done") {
        return {
          kind: "result",
          result: await finalizeDone({
            action,
            caller: input.crashCleanupState.caller,
            mode: input.mode,
            terminalState: input.crashCleanupState,
          }),
        };
      }

      if (action.cancelled === true) {
        const settled = await settleCancelledTurnStep({
          parentWritable: input.sessionWritable,
          serializedContext: stateCursor.serializedContext,
          sessionState: stateCursor.sessionState,
        });
        stateCursor.adoptState(settled);
        input.crashCleanupState.serializedContext = stateCursor.serializedContext;
        const cancelledCaller = {
          caller: input.crashCleanupState.caller,
          sessionId: stateCursor.sessionState.sessionId,
        };
        await notifyCancelledTaskCallerStep(
          settled.usage === undefined
            ? cancelledCaller
            : { ...cancelledCaller, usage: settled.usage },
        );
        input.crashCleanupState.lastSessionState = stateCursor.sessionState;
      }

      // `settled` rides the typed park arm exclusively; `run-step` preserves
      // the full StepResult so no state-key fallback exists anymore.
      const settled = action.settled;
      if (action.cancelled !== true && settled !== undefined) {
        if (input.crashCleanupState.caller !== undefined) {
          await notifyTurnCallerStep({
            caller: input.crashCleanupState.caller,
            lifecycle: "parked",
            sessionId: stateCursor.sessionState.sessionId,
            settled,
          });
        }
        input.crashCleanupState.caller = undefined;
      } else if (action.cancelled === true) {
        input.crashCleanupState.caller = undefined;
      }

      // An open authorization challenge must not wedge the session:
      // ordinary deliveries keep starting normal turns while the challenge
      // waits for its callback, and the callback surfaces through the same
      // parked wait as everything else. The pending challenge survives
      // intervening turns because every park re-derives
      // `authorizationAttemptIds` from durable session state.
      const next = await nextParkedActivity({
        expectedAttemptIds: action.authorizationAttemptIds ?? [],
      });
      input.crashCleanupState.lastSessionState = stateCursor.sessionState;

      if (next.kind === "authorization-resume") {
        action = await runTurn({
          kind: "deliver",
          payloads: next.payloads,
        });
        continue;
      }

      if (next.kind === "expired") {
        return {
          kind: "expired",
          serializedContext: stateCursor.serializedContext,
          sessionState: stateCursor.sessionState,
        };
      }

      if (next.kind === "reset") {
        return {
          kind: "result",
          result: await finalizeExpiredSession({
            caller: input.crashCleanupState.caller,
            sessionWritable: input.sessionWritable,
            mode: input.mode,
            serializedContext: stateCursor.serializedContext,
            sessionState: stateCursor.sessionState,
            terminalState: input.crashCleanupState,
          }),
        };
      }

      if (next.kind === "clear" || next.kind === "compact") {
        action = await runTurn({ kind: next.kind });
        continue;
      }

      if (next.kind === "closed") {
        return {
          kind: "result",
          result: await finalizeExpiredSession({
            caller: input.crashCleanupState.caller,
            sessionWritable: input.sessionWritable,
            mode: input.mode,
            serializedContext: stateCursor.serializedContext,
            sessionState: stateCursor.sessionState,
            terminalState: input.crashCleanupState,
          }),
        };
      }

      if (next.kind === "cancel-turn") {
        await cancelDescendantTurnsStep({
          serializedContext: stateCursor.serializedContext,
          sessionState: stateCursor.sessionState,
        });
        const cancelled = await settleCancelledTurnStep({
          parentWritable: input.sessionWritable,
          serializedContext: stateCursor.serializedContext,
          sessionState: stateCursor.sessionState,
        });
        stateCursor.adoptState(cancelled);
        input.crashCleanupState.serializedContext = stateCursor.serializedContext;
        // Re-enter with `settled` cleared: the parked answer was already
        // delivered to its caller before this wait, so the next iteration
        // must not treat it as a fresh settlement.
        action = { ...action, settled: undefined };
        input.crashCleanupState.caller = undefined;
        input.crashCleanupState.lastSessionState = stateCursor.sessionState;
        continue;
      }

      const handoff = new SessionHandoff({
        anchorToken: input.anchorToken,
        bufferedDeliveries,
        bufferedSessionControls,
        caller: input.crashCleanupState.caller,
        capabilities: input.capabilities,
        commandInbox,
        mode: input.mode,
        ownership: {
          anchorRunId: input.anchorRunId,
          deploymentId: input.ownerDeploymentId,
          ownerRunId: input.ownerRunId,
          sessionId: input.sessionId,
        },
        retention: input.retention,
        serializedContext: stateCursor.serializedContext,
        sessionState: stateCursor.sessionState,
        sessionTimeoutDeadline: input.sessionTimeoutDeadline,
      });
      const checkpoint = await handoff.checkpoint(next.delivery);
      if (checkpoint.kind === "ready") {
        await input.ensureAnchor();
        const acceptedDuringRelease = await handoff.release();
        if (acceptedDuringRelease.length > 0) {
          await handoff.recover(acceptedDuringRelease);
        } else {
          let acceptedByFailedCandidate: readonly SessionInboxPayload[] = [];
          try {
            const candidate = await handoff.start(checkpoint);
            const activation = await handoff.activate(candidate);
            if (activation.kind === "active") return { kind: "transferred" };
            acceptedByFailedCandidate = activation.payloads;
          } catch {
            // The current owner remains authoritative until activation.
          }
          await handoff.recover(acceptedByFailedCandidate);
        }
      }

      if (next.delivery.caller !== undefined) {
        input.crashCleanupState.caller = next.delivery.caller;
      }
      action = await runTurn(next.delivery);
    }
  } finally {
    await sessionTimeout?.dispose();
  }
}
