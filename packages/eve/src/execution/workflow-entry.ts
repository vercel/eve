import { getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

import type {
  DeliverHookPayload,
  DeliverPayload,
  HookPayload,
  RunInput,
  SessionCommand,
  SessionCapabilities,
  TurnCaller,
} from "#channel/types.js";
import { readChannelRequestId, readRootSessionId } from "#execution/eve-workflow-attributes.js";
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
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import { rebaseTaskAgentHandleMutations } from "#execution/agent-handle-state-rebase.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { dispatchAndAwaitTurn } from "#execution/turn-dispatch.js";
import type { TurnDriverAction } from "#execution/turn-control-receiver.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { fireSessionCallbackStep } from "#subagents/callback-step.js";
import { finalizeDone, finalizeExpiredSession } from "#execution/workflow-entry-finalization.js";
import { isHookConflictError } from "#execution/hook-ownership.js";
import {
  createSessionCommandInbox,
  type SessionCommandInbox,
} from "#execution/session-command-inbox.js";
import {
  createSessionCommandRouter,
  type SessionCommandRouter,
} from "#execution/session-command-router.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session-timeout.js";
import { createSessionTimeoutControl } from "#execution/session-timeout-control.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { CHANNEL_CONTEXT_KEY_NAME, SESSION_CALLBACK_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter-state.js";
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";

const SAFE_OUTER_WORKFLOW_FAILURE_MESSAGE =
  "Agent workflow failed. Inspect the private session trace for details.";

// workflow-entry.ts is the durable workflow body — the bundler rejects
// node built-ins here, so `internal/logging.ts` cannot be imported.
// Error logging happens inside `emitTerminalSessionFailureStep`.

/**
 * Serializable workflow-entry input. All runtime state travels via
 * `serializedContext`, which is produced by `serializeContext(ctx)`
 * and deserialized at each `"use step"` boundary.
 */
export interface WorkflowEntryInput {
  readonly activityCollectorRunId?: string;
  readonly continuationConflictCommand?: Extract<SessionCommand, { readonly kind: "send" }>;
  readonly input: RunInput["input"];
  readonly limits?: RunInput["limits"];
  readonly sessionTimeoutMs?: number | false;
  readonly serializedContext: Record<string, unknown>;
  readonly taskId?: string;
}

export interface WorkflowEntryResult {
  readonly output: unknown;
}

type DriverLoopOutcome =
  | {
      readonly kind: "expired";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "result";
      readonly result: WorkflowEntryResult;
    };

/**
 * Write-through cell owned by {@link workflowEntry}: written
 * unconditionally by the driver loop as turns advance, read only by the
 * outer catch. When the loop throws, its locals are unreachable, so this
 * cell is the crash path's only view of values that changed after turn 1.
 *
 * Reach for this cell only when all three hold for a value:
 * 1. it is produced or replaced inside the driver loop, so the entry
 *    function's own locals go stale;
 * 2. it travels by value inside Workflow step results — there is no
 *    store the catch could re-read it from at crash time;
 * 3. the crash path needs its latest value to discharge a cleanup
 *    obligation.
 * If any of the three fails, read the value from where it already lives
 * instead of mirroring it here.
 */
interface CrashCleanupState {
  // The caller whose awaited reply is still unsettled, so the catch can
  // reject it with the error instead of leaving it parked forever.
  // Populated for every session; only conversation-mode paths read it.
  caller: TurnCaller | undefined;
  // Whether `resolveInitialTurnCallerStep` has run. `caller: undefined` is
  // ambiguous on its own: it also means "resolved and later cleared because
  // its reply settled". This flag lets the crash path tell that apart from
  // "crashed before the caller was ever resolved", where a delegated caller
  // may still be parked on this session's reply.
  callerResolved: boolean;
  // The latest snapshot the driver has received, so the catch can
  // terminate children adopted after turn 1. Honest staleness window: the
  // driver only sees state at turn boundaries, so children dispatched by a
  // turn that crashed mid-flight are absent from this snapshot and escape
  // crash cleanup.
  lastSessionState: DurableSessionState | undefined;
  serializedContext: Record<string, unknown>;
  terminalEmitted: boolean;
  turnId?: string;
}

/**
 * Long-lived workflow entrypoint. Handles both root sessions and
 * delegated child sessions: root sessions expose only parent
 * control-plane events; delegated children publish their full progress
 * on a child stream and resume the parked parent with a
 * `subagent-result` on completion.
 *
 * Owns the stable command inbox, its channel alias, and the session lifecycle; each turn-owned
 * turn resolves its own runtime actions in-line and reports back only
 * `done`/`park` via the closed-contract {@link NextDriverAction}. The
 * only session-shape flag the driver reads (besides identity) is
 * `hasProxyInputRequests`, the documented short-circuit for hook-payload
 * routing to any descendant still active when the parent parks.
 */
export async function workflowEntry(input: WorkflowEntryInput): Promise<WorkflowEntryResult> {
  "use workflow";

  const { workflowRunId: sessionId, workflowStartedAt } = getWorkflowMetadata();
  const continuationToken = (input.serializedContext["eve.continuationToken"] as string) || "";
  const mode = input.serializedContext["eve.mode"] as RunMode;
  const capabilities = input.serializedContext["eve.capabilities"] as
    | SessionCapabilities
    | undefined;
  const serializedBundle = input.serializedContext["eve.bundle"] as {
    source: DurableCompiledArtifactsSource;
    nodeId?: string;
  };

  // Seed `eve.sessionId` so the terminal failure emitter can stamp it
  // onto `session.failed` even if `createSessionStep` itself throws.
  input.serializedContext["eve.sessionId"] = sessionId;

  const driverWritable = getWritable<Uint8Array>();
  const crashCleanupState: CrashCleanupState = {
    caller: undefined,
    callerResolved: false,
    lastSessionState: undefined,
    serializedContext: input.serializedContext,
    terminalEmitted: false,
  };

  try {
    // Derived once and reused for createSession + tag emission so the
    // chain-root id can never drift between persisted session and tags.
    const rootSessionIdFromParent = readRootSessionId(input.serializedContext);
    const dynamicSubagentAgentConfig = input.serializedContext["eve.dynamicSubagentAgentConfig"] as
      | DynamicSubagentAgentConfig
      | undefined;

    const commandInbox = createSessionCommandInbox();
    const commandRouter = createSessionCommandRouter();
    const stableCommandToken = sessionCommandHookToken(sessionId);
    const authorizationHookToken = `${sessionId}:auth`;
    let sessionState: DurableSessionState;
    let outcome: DriverLoopOutcome;
    try {
      const [sessionCreation, stableClaim, authorizationClaim, continuationClaim] =
        await Promise.allSettled([
          createSessionStep({
            compiledArtifactsSource: serializedBundle.source,
            continuationToken,
            dynamicSubagentAgentConfig,
            inheritedLimits: input.limits,
            nodeId: serializedBundle.nodeId,
            outputSchema: input.input.outputSchema,
            rootSessionId: rootSessionIdFromParent,
            sessionId,
            taskId: input.taskId,
          }),
          commandInbox.claimStable(stableCommandToken),
          commandInbox.claimAuthorization(authorizationHookToken),
          commandInbox.rekeyContinuation(continuationToken),
        ]);

      if (sessionCreation.status === "rejected") throw sessionCreation.reason;
      if (stableClaim.status === "rejected") throw stableClaim.reason;
      if (authorizationClaim.status === "rejected") throw authorizationClaim.reason;
      if (continuationClaim.status === "rejected") {
        // Only the durable alias owner runs a first turn; a losing candidate
        // hands its address delivery to that owner before exiting.
        if (isHookConflictError(continuationClaim.reason)) {
          if (
            input.activityCollectorRunId !== undefined ||
            input.continuationConflictCommand !== undefined
          ) {
            await settleContinuationConflictStep({
              activityCollectorRunId: input.activityCollectorRunId,
              command: input.continuationConflictCommand,
              continuationToken,
              ownerSessionId:
                typeof continuationClaim.reason.conflictingRunId === "string"
                  ? continuationClaim.reason.conflictingRunId
                  : undefined,
            });
          }
          return { output: "" };
        }
        throw continuationClaim.reason;
      }

      sessionState = sessionCreation.value.state;
      crashCleanupState.lastSessionState = sessionState;
      crashCleanupState.caller = hasDelegatedCallerContext(input.serializedContext)
        ? await resolveInitialTurnCallerStep({ serializedContext: input.serializedContext })
        : undefined;
      crashCleanupState.callerResolved = true;

      outcome = await runDriverLoop({
        capabilities,
        commandInbox,
        commandRouter,
        driverWritable,
        initialInput: {
          deliveryMetadata:
            input.serializedContext["eve.channelDelivery"] === undefined
              ? undefined
              : [
                  {
                    ...(input.serializedContext["eve.channelDelivery"] as NonNullable<
                      RunInput["delivery"]
                    >),
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
          requestId: readChannelRequestId(input.serializedContext),
        },
        crashCleanupState,
        mode,
        serializedContext: input.serializedContext,
        sessionState,
        sessionTimeoutDeadline:
          input.sessionTimeoutMs === false
            ? undefined
            : new Date(
                workflowStartedAt.getTime() +
                  (input.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS),
              ),
        stableCommandToken,
      });
    } finally {
      await commandInbox.dispose();
    }
    if (outcome.kind === "result") {
      return outcome.result;
    }
    return await finalizeExpiredSession({
      caller: crashCleanupState.caller,
      driverWritable,
      mode,
      serializedContext: outcome.serializedContext,
      sessionState: outcome.sessionState,
      terminalState: crashCleanupState,
    });
  } catch (error) {
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
        parentWritable: driverWritable,
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
    throw createSafeOuterWorkflowError();
  }
}

function hasDelegatedCallerContext(serializedContext: Record<string, unknown>): boolean {
  if (serializedContext["eve.sessionCallback"] !== undefined) return true;
  const channel = serializedContext["eve.channel"];
  return (
    typeof channel === "object" && channel !== null && Reflect.get(channel, "kind") === "subagent"
  );
}

/**
 * Caller to reject from the crash path. Normally the resolved cell value —
 * including `undefined` after a settled reply cleared it, when there is
 * nothing left to notify. When the crash happened before
 * `resolveInitialTurnCallerStep` ever ran (e.g. `createSessionStep` threw),
 * the cell is empty even though a delegated caller may be parked on this
 * session's reply, so the caller is re-resolved from the serialized context
 * — which needs nothing from the failed steps. Best-effort: when resolution
 * fails again there is no reachable caller to notify.
 */
async function resolveCallerForCrash(
  state: CrashCleanupState,
  serializedContext: Record<string, unknown>,
): Promise<TurnCaller | undefined> {
  if (state.callerResolved) {
    return state.caller;
  }
  try {
    return await resolveInitialTurnCallerStep({ serializedContext });
  } catch {
    return undefined;
  }
}

function createSafeOuterWorkflowError(): Error {
  const error = new Error(SAFE_OUTER_WORKFLOW_FAILURE_MESSAGE);
  error.name = "EveWorkflowFailure";
  return error;
}

async function runDriverLoop(input: {
  readonly capabilities?: SessionCapabilities;
  readonly commandInbox: SessionCommandInbox;
  readonly commandRouter: SessionCommandRouter;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly initialInput: HookPayload;
  readonly crashCleanupState: CrashCleanupState;
  readonly mode: RunMode;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutDeadline?: Date;
  readonly stableCommandToken: string;
}): Promise<DriverLoopOutcome> {
  const commandInbox = input.commandInbox;
  const commandRouter = input.commandRouter;
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
   * across intervening turns; once every expected challenge has reported
   * (or the hook closed), the collected payloads resume the challenge.
   */
  const nextParkedActivity = async (park: {
    readonly expectedAttemptIds: readonly string[];
  }): Promise<
    | { readonly kind: "authorization-resume"; readonly payloads: DeliverPayload[] }
    | Exclude<NextTurnInstruction, { kind: "authorization" }>
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
        callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
        cancelledTaskIds,
        commandInbox,
        commandRouter,
        deferDeliveries: input.mode === "task" && expectedAttemptIds.size > 0,
        driverWritable: input.driverWritable,
        seenTaskDeliveries,
        stateCursor,
      });
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
      if (next.closed) {
        const payloads = [...collectedAuthPayloads.values()];
        collectedAuthPayloads.clear();
        return { kind: "authorization-resume", payloads };
      }
    }
  };
  // Fast descendant resumes can start the next turn before the prior
  // control hook disposal is persisted by the Workflow SDK, so each
  // turn needs its own session-scoped token.
  let turnDispatchIndex = 0;
  const nextTurnControlToken = (): string =>
    `${input.sessionState.sessionId}:turn-control:${String(turnDispatchIndex++)}`;

  const bufferedDeliveries: DeliverHookPayload[] = [];
  const bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset"> = [];
  const cancelledTaskIds = new Set<string>();
  const seenTaskDeliveries = new Set<string>();
  const stateCursor = new SessionStateCursor({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  const sessionTimeout =
    input.sessionTimeoutDeadline === undefined
      ? undefined
      : createSessionTimeoutControl({
          deadline: input.sessionTimeoutDeadline,
          token: input.stableCommandToken,
        });

  // Control-hook disposal is deferred one turn — see DispatchedTurn.
  let disposeSettledTurnControl: (() => Promise<void>) | undefined;
  const runTurn = async (delivery: HookPayload): Promise<TurnDriverAction> => {
    const dispatchedSessionState = stateCursor.sessionState;
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
    input.crashCleanupState.turnId = `turn_${String(turnDispatchIndex)}`;
    const turn = await dispatchAndAwaitTurn({
      bufferedDeliveries,
      bufferedSessionControls,
      cancelledTaskIds,
      capabilities: input.capabilities,
      commandInbox,
      commandRouter,
      controlToken: nextTurnControlToken(),
      delivery,
      mode: input.mode,
      parentWritable: input.driverWritable,
      serializedContext,
      seenTaskDeliveries,
      sessionState: stateCursor.sessionState,
    });
    await disposeSettledTurnControl?.();
    disposeSettledTurnControl = turn.dispose;
    const action =
      stateCursor.sessionState === dispatchedSessionState
        ? turn.action
        : rebaseTaskAgentHandleMutations(turn.action, stateCursor.sessionState);
    stateCursor.adoptState(action);
    input.crashCleanupState.lastSessionState = stateCursor.sessionState;
    input.crashCleanupState.serializedContext = stateCursor.serializedContext;
    return action;
  };

  try {
    await sessionTimeout?.start();

    let action: TurnDriverAction = await runTurn(input.initialInput);

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

      if (action.kind !== "park") {
        // Turn-owned turns resolve runtime actions in-line and only ever
        // report `done`/`park`. The driver-owned `dispatch-*` arms exist
        // solely for pre-change pinned drivers, which run their own code.
        throw new Error(`Driver received unexpected turn action "${action.kind}".`);
      }

      if (action.cancelled === true) {
        const settled = await settleCancelledTurnStep({
          parentWritable: input.driverWritable,
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

      // Channel-created sessions may rekey their dynamic alias. Sessions
      // without one remain reachable through the stable command inbox only.
      if (stateCursor.sessionState.continuationToken) {
        await commandInbox.rekeyContinuation(stateCursor.sessionState.continuationToken);
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
            driverWritable: input.driverWritable,
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
            driverWritable: input.driverWritable,
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
          parentWritable: input.driverWritable,
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

      if (next.delivery.caller !== undefined) {
        input.crashCleanupState.caller = next.delivery.caller;
      }
      action = await runTurn(next.delivery);
    }
  } finally {
    await disposeSettledTurnControl?.();
    await sessionTimeout?.dispose();
  }
}
