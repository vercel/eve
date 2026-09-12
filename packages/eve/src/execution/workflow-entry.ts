import { getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

import type {
  DeliverHookPayload,
  DeliverPayload,
  RunInput,
  SessionCapabilities,
  TurnCaller,
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
import { SessionBacklog } from "#execution/session-backlog.js";
import { SessionExecution } from "#execution/session-execution.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { TurnOutcome, TurnStepPayload } from "#execution/turn-step.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { fireSessionCallbackStep } from "#subagents/callback-step.js";
import { finalizeDone, finalizeExpiredSession } from "#execution/workflow-entry-finalization.js";
import { isHookConflictError } from "#execution/hook-ownership.js";
import {
  createSessionInbox,
  claimSessionHooks,
  type SessionInboxHandle,
} from "#execution/session-inbox/inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session-timeout.js";
import { createSessionTimeoutControl } from "#execution/session-timeout-control.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";
import { SESSION_INBOX_CONTEXT_KEY } from "#execution/session-inbox/address.js";
import { SessionHandoff, type SessionOwnership } from "#execution/session-handoff.js";
import {
  signalSessionAnchorStep,
  signalSessionOwnerActivationStep,
} from "#execution/session-handoff-steps.js";
import { validateSessionCheckpointStep } from "#execution/session-checkpoint-validation-step.js";
import type {
  HandoffWorkflowEntryInput,
  InitialWorkflowEntryInput,
  WorkflowEntryInput,
  WorkflowEntryResult,
} from "#execution/workflow-entry-input.js";

// workflow-entry.ts is the durable workflow body — the bundler rejects
// node built-ins here, so `internal/logging.ts` cannot be imported.
// Error logging happens inside `emitTerminalSessionFailureStep`.

/** Everything the session loop needs, resolved identically for both boot paths. */
interface SessionBoot {
  readonly anchorToken: string;
  readonly capabilities?: SessionCapabilities;
  readonly caller: TurnCaller | undefined;
  readonly initialDelivery: DeliverHookPayload;
  readonly isInitialOwner: boolean;
  readonly mode: RunMode;
  readonly ownership: SessionOwnership;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutDeadline?: Date;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

type SessionLoopOutcome =
  | {
      readonly kind: "expired";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | { readonly kind: "result"; readonly result: WorkflowEntryResult }
  | { readonly kind: "transferred" };

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

  const { workflowRunId: ownerRunId } = getWorkflowMetadata();
  const sessionId = input.kind === "initial" ? ownerRunId : input.checkpoint.ownership.sessionId;
  const serializedContext =
    input.kind === "initial" ? input.serializedContext : { ...input.checkpoint.serializedContext };
  serializedContext["eve.sessionId"] = sessionId;
  serializedContext[SESSION_INBOX_CONTEXT_KEY] = { sessionId };

  const sessionWritable =
    input.kind === "initial" ? getWritable<Uint8Array>() : input.parentWritable;
  const mode: RunMode =
    input.kind === "initial" ? (serializedContext["eve.mode"] as RunMode) : input.checkpoint.mode;
  const crashCleanupState: CrashCleanupState = {
    caller: undefined,
    callerResolved: false,
    lastSessionState: undefined,
    serializedContext,
    terminalEmitted: false,
  };
  const commandInbox = createSessionInbox(sessionId);
  const backlog = new SessionBacklog();
  let handoff: SessionHandoff | undefined;
  let activated = input.kind === "initial";

  try {
    let outcome: SessionLoopOutcome;
    try {
      const boot =
        input.kind === "initial"
          ? await bootInitialOwner(input, {
              commandInbox,
              ownerRunId,
              serializedContext,
              sessionWritable,
            })
          : await bootHandoffOwner(input, {
              commandInbox,
              ownerRunId,
              serializedContext,
              sessionWritable,
            });
      if (boot === undefined) return { output: "" };
      activated = true;
      crashCleanupState.caller = boot.caller;
      crashCleanupState.callerResolved = true;
      crashCleanupState.lastSessionState = boot.sessionState;

      handoff = new SessionHandoff({
        anchorToken: boot.anchorToken,
        backlog,
        capabilities: boot.capabilities,
        commandInbox,
        isInitialOwner: boot.isInitialOwner,
        mode: boot.mode,
        ownership: boot.ownership,
        retention: boot.retention,
        sessionTimeoutDeadline: boot.sessionTimeoutDeadline,
      });
      outcome = await runSessionLoop(boot, { backlog, commandInbox, crashCleanupState, handoff });
    } finally {
      if (activated) await commandInbox.dispose();
    }

    if (outcome.kind === "transferred") {
      return input.kind === "initial" ? await handoff!.awaitAnchoredResult() : { output: "" };
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
    await reportResultToAnchor(input, result, handoff);
    return result;
  } catch (error) {
    if (!activated && input.kind === "handoff") {
      // A candidate that never activated hands accepted payloads back to the owner.
      await signalSessionOwnerActivationStep({
        activation: {
          error: normalizeSerializableError(error),
          kind: "failed",
          payloads: await commandInbox.release(),
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
    await reportResultToAnchor(input, { output: "" }, handoff);
    throw createSafeOuterWorkflowError();
  }
}

/** A successor reports the final result to the anchor; the original run just releases it. */
async function reportResultToAnchor(
  input: WorkflowEntryInput,
  result: WorkflowEntryResult,
  handoff: SessionHandoff | undefined,
): Promise<void> {
  if (input.kind === "handoff") {
    await signalSessionAnchorStep({ result, token: input.checkpoint.anchorToken });
  } else {
    await handoff?.disposeAnchor();
  }
}

interface BootContext {
  readonly commandInbox: SessionInboxHandle;
  readonly ownerRunId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

/** Returns `undefined` when a competing continuation owner already exists. */
async function bootInitialOwner(
  input: InitialWorkflowEntryInput,
  context: BootContext,
): Promise<SessionBoot | undefined> {
  const { commandInbox, ownerRunId: sessionId, serializedContext } = context;
  const { workflowStartedAt } = getWorkflowMetadata();
  const continuationToken = (serializedContext["eve.continuationToken"] as string) || "";
  const serializedBundle = serializedContext["eve.bundle"] as {
    source: DurableCompiledArtifactsSource;
    nodeId?: string;
  };
  const [sessionCreation, stableClaim, aliasClaim] = await Promise.allSettled([
    createSessionStep({
      compiledArtifactsSource: serializedBundle.source,
      continuationToken,
      dynamicSubagentAgentConfig: serializedContext["eve.dynamicSubagentAgentConfig"] as
        | DynamicSubagentAgentConfig
        | undefined,
      inheritedLimits: input.limits,
      nodeId: serializedBundle.nodeId,
      outputSchema: input.input.outputSchema,
      rootSessionId: readRootSessionId(serializedContext),
      sessionId,
      taskId: input.taskId,
    }),
    commandInbox.claimSessionHook(sessionCommandHookToken(sessionId)),
    continuationToken === "" ? Promise.resolve() : commandInbox.claimSessionHook(continuationToken),
  ]);
  if (sessionCreation.status === "rejected") throw sessionCreation.reason;
  if (stableClaim.status === "rejected") throw stableClaim.reason;
  if (aliasClaim.status === "rejected") {
    if (!isHookConflictError(aliasClaim.reason)) throw aliasClaim.reason;
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
    return undefined;
  }

  return {
    anchorToken: `${sessionId}:anchor`,
    caller: hasDelegatedCallerContext(serializedContext)
      ? await resolveInitialTurnCallerStep({ serializedContext })
      : undefined,
    capabilities: serializedContext["eve.capabilities"] as SessionCapabilities | undefined,
    initialDelivery: createInitialDelivery(input, serializedContext),
    isInitialOwner: true,
    mode: serializedContext["eve.mode"] as RunMode,
    ownership: {
      anchorRunId: sessionId,
      deploymentId: input.ownerDeploymentId,
      ownerRunId: sessionId,
      sessionId,
    },
    retention: input.retention,
    serializedContext,
    sessionState: sessionCreation.value.state,
    sessionTimeoutDeadline:
      input.sessionTimeoutMs === false
        ? undefined
        : new Date(
            workflowStartedAt.getTime() + (input.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS),
          ),
    sessionWritable: context.sessionWritable,
  };
}

/** Validates, claims the exact hook set, then tells the previous owner it may exit. */
async function bootHandoffOwner(
  input: HandoffWorkflowEntryInput,
  context: BootContext,
): Promise<SessionBoot> {
  const { checkpoint } = input;
  await validateSessionCheckpointStep({ checkpoint });
  await claimSessionHooks(context.commandInbox, checkpoint.hooks.session);
  await signalSessionOwnerActivationStep({
    activation: { kind: "active" },
    token: input.activationToken,
  });
  return {
    anchorToken: checkpoint.anchorToken,
    caller: checkpoint.caller,
    capabilities: checkpoint.capabilities,
    initialDelivery: input.delivery,
    isInitialOwner: false,
    mode: checkpoint.mode,
    ownership: {
      ...checkpoint.ownership,
      deploymentId: input.ownerDeploymentId,
      ownerRunId: context.ownerRunId,
    },
    retention: checkpoint.retention,
    serializedContext: context.serializedContext,
    sessionState: checkpoint.sessionState,
    sessionTimeoutDeadline: checkpoint.sessionTimeoutDeadline,
    sessionWritable: context.sessionWritable,
  };
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

async function runSessionLoop(
  boot: SessionBoot,
  deps: {
    readonly backlog: SessionBacklog;
    readonly commandInbox: SessionInboxHandle;
    readonly crashCleanupState: CrashCleanupState;
    readonly handoff: SessionHandoff;
  },
): Promise<SessionLoopOutcome> {
  const { backlog, commandInbox, crashCleanupState, handoff } = deps;
  const cursor = new SessionStateCursor({
    commandInbox,
    parentWritable: boot.sessionWritable,
    serializedContext: boot.serializedContext,
    sessionState: boot.sessionState,
  });
  const execution = new SessionExecution({
    backlog,
    capabilities: boot.capabilities,
    commandInbox,
    cursor,
    mode: boot.mode,
  });
  // One payload per exact authorization attempt accumulates across
  // intervening turns. Replaced attempts are pruned at each park.
  const collectedAuthPayloads = new Map<string, DeliverPayload>();
  const stableCommandToken = commandInbox.sessionHookTokens[0];
  if (stableCommandToken === undefined)
    throw new Error("Session owner requires a stable inbox hook.");
  const sessionTimeout =
    boot.sessionTimeoutDeadline === undefined
      ? undefined
      : createSessionTimeoutControl({
          deadline: boot.sessionTimeoutDeadline,
          token: stableCommandToken,
        });

  /**
   * Waits for the next parked-session activity. While an authorization
   * challenge is open (`expected > 0`), callback reads surface through the
   * same single FIFO wait as ordinary session activity — one arrival order,
   * which keeps the wait deterministic under workflow replay — and keep
   * surfacing across wait iterations that produce no parent turn. Callbacks
   * accumulate across intervening turns; once every expected challenge has
   * reported, the collected payloads resume the challenge.
   */
  const nextParkedActivity = async (
    expectedAttemptIds: ReadonlySet<string>,
  ): Promise<
    | { readonly kind: "authorization-resume"; readonly payloads: DeliverPayload[] }
    | Exclude<NextTurnInstruction, { kind: "authorization" | "workflow" }>
  > => {
    for (const attemptId of collectedAuthPayloads.keys()) {
      if (!expectedAttemptIds.has(attemptId)) collectedAuthPayloads.delete(attemptId);
    }
    while (true) {
      if (
        expectedAttemptIds.size > 0 &&
        [...expectedAttemptIds].every((attemptId) => collectedAuthPayloads.has(attemptId))
      ) {
        const payloads = [...expectedAttemptIds].map((id) => collectedAuthPayloads.get(id)!);
        collectedAuthPayloads.clear();
        return { kind: "authorization-resume", payloads };
      }
      const next = await nextTurnDelivery({
        awaitAuthorizationCallbacks: expectedAttemptIds.size > 0,
        backlog,
        commandInbox,
        cursor,
        deferDeliveries: boot.mode === "task" && expectedAttemptIds.size > 0,
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

  let turnIndex = 0;
  const runTurn = async (delivery: TurnStepPayload): Promise<TurnOutcome> => {
    const caller = crashCleanupState.caller;
    if (caller?.taskId !== undefined) backlog.markTaskSeen(caller.taskId);
    if (caller !== undefined) {
      cursor.adoptState(
        await bindTurnCallerContextStep({ caller, serializedContext: cursor.serializedContext }),
      );
    }
    crashCleanupState.turnId = `turn_${String(turnIndex++)}`;
    const outcome = await execution.runTurn(delivery);
    cursor.adoptState(outcome);
    crashCleanupState.lastSessionState = cursor.sessionState;
    crashCleanupState.serializedContext = cursor.serializedContext;
    return outcome;
  };
  const settleCancelledTurn = async () => {
    const settled = await settleCancelledTurnStep({
      parentWritable: boot.sessionWritable,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    });
    cursor.adoptState(settled);
    crashCleanupState.serializedContext = cursor.serializedContext;
    crashCleanupState.lastSessionState = cursor.sessionState;
    crashCleanupState.caller = undefined;
    return settled;
  };
  const finalize = async (): Promise<SessionLoopOutcome> => ({
    kind: "result",
    result: await finalizeExpiredSession({
      caller: crashCleanupState.caller,
      sessionWritable: boot.sessionWritable,
      mode: boot.mode,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
      terminalState: crashCleanupState,
    }),
  });

  try {
    const [actionResult, timerResult] = await Promise.allSettled([
      runTurn(boot.initialDelivery),
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
            caller: crashCleanupState.caller,
            mode: boot.mode,
            terminalState: crashCleanupState,
          }),
        };
      }

      if (action.cancelled === true) {
        const cancelledCaller = {
          caller: crashCleanupState.caller,
          sessionId: cursor.sessionState.sessionId,
        };
        const settled = await settleCancelledTurn();
        await notifyCancelledTaskCallerStep(
          settled.usage === undefined
            ? cancelledCaller
            : { ...cancelledCaller, usage: settled.usage },
        );
      } else if (action.settled !== undefined) {
        if (crashCleanupState.caller !== undefined) {
          await notifyTurnCallerStep({
            caller: crashCleanupState.caller,
            lifecycle: "parked",
            sessionId: cursor.sessionState.sessionId,
            settled: action.settled,
          });
        }
        crashCleanupState.caller = undefined;
      }

      // An open authorization challenge must not wedge the session:
      // ordinary deliveries keep starting normal turns while the challenge
      // waits for its callback. The pending challenge survives intervening
      // turns because every park re-derives `authorizationAttemptIds` from
      // durable session state.
      const next = await nextParkedActivity(new Set(action.authorizationAttemptIds ?? []));
      crashCleanupState.lastSessionState = cursor.sessionState;

      switch (next.kind) {
        case "authorization-resume":
          action = await runTurn({ kind: "deliver", payloads: next.payloads });
          continue;
        case "expired":
          return {
            kind: "expired",
            serializedContext: cursor.serializedContext,
            sessionState: cursor.sessionState,
          };
        case "reset":
        case "closed":
          return await finalize();
        case "clear":
        case "compact":
          action = await runTurn({ kind: next.kind });
          continue;
        case "cancel-turn":
          await cancelDescendantTurnsStep({
            serializedContext: cursor.serializedContext,
            sessionState: cursor.sessionState,
          });
          await settleCancelledTurn();
          // Re-enter with `settled` cleared: the parked answer was already
          // delivered to its caller before this wait.
          action = { ...action, settled: undefined };
          continue;
        case "turn": {
          const transferred = await handoff.transfer(next.delivery, {
            caller: crashCleanupState.caller,
            serializedContext: cursor.serializedContext,
            sessionState: cursor.sessionState,
          });
          if (transferred) return { kind: "transferred" };
          if (next.delivery.caller !== undefined) crashCleanupState.caller = next.delivery.caller;
          action = await runTurn(next.delivery);
          continue;
        }
      }
    }
  } finally {
    await sessionTimeout?.dispose();
  }
}
