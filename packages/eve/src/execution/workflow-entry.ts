import { getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

import type {
  DeliverHookPayload,
  DeliverPayload,
  HookPayload,
  RunInput,
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
  notifyTaskTurnStartedStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#execution/delegated-parent-notification.js";
import {
  createDelegatedSubagentErrorResult,
  createDelegatedSubagentSuccessResult,
} from "#execution/delegated-parent-result.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { nextTurnDelivery, type NextTurnInstruction } from "#execution/parked-delivery-wait.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { dispatchAndAwaitTurn } from "#execution/turn-dispatch.js";
import type { TurnDriverAction } from "#execution/turn-control-receiver.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { settleProgressWorkStep } from "#execution/settle-progress-work-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";
import { isHookConflictError } from "#execution/hook-ownership.js";
import { createSessionCommandInbox } from "#execution/session-command-inbox.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session-timeout.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { createSessionTimeoutControl } from "#execution/session-timeout-control.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { readSerializedSubagentDepth } from "#harness/subagent-depth.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { isTaskOwnedSerializedContext } from "#execution/tasks/child/instructions.js";
import {
  createSafeOuterWorkflowError,
  resolveCallerForCrash,
  type CrashCleanupState,
} from "#execution/workflow-entry-crash.js";

// workflow-entry.ts is the durable workflow body — the bundler rejects
// node built-ins here, so `internal/logging.ts` cannot be imported.
// Error logging happens inside `emitTerminalSessionFailureStep`.

/**
 * Serializable workflow-entry input. All runtime state travels via
 * `serializedContext`, which is produced by `serializeContext(ctx)`
 * and deserialized at each `"use step"` boundary.
 */
export interface WorkflowEntryInput {
  readonly input: RunInput["input"];
  readonly limits?: RunInput["limits"];
  readonly sessionTimeoutMs?: number | false;
  readonly serializedContext: Record<string, unknown>;
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
  };

  try {
    // Derived once and reused for createSession + tag emission so the
    // chain-root id can never drift between persisted session and tags.
    const rootSessionIdFromParent = readRootSessionId(input.serializedContext);
    const subagentDepth = readSerializedSubagentDepth(input.serializedContext);
    const dynamicSubagentAgentConfig = input.serializedContext["eve.dynamicSubagentAgentConfig"] as
      | DynamicSubagentAgentConfig
      | undefined;

    const { state: sessionState } = await createSessionStep({
      compiledArtifactsSource: serializedBundle.source,
      continuationToken,
      dynamicSubagentAgentConfig,
      inheritedLimits: input.limits,
      nodeId: serializedBundle.nodeId,
      outputSchema: input.input.outputSchema,
      rootSessionId: rootSessionIdFromParent,
      sessionId,
      subagentDepth,
      taskOwned: isTaskOwnedSerializedContext(input.serializedContext),
    });
    crashCleanupState.lastSessionState = sessionState;
    // Resolved for every session so the cell's population never depends
    // on session shape: the step returns undefined for root sessions,
    // and every reader is mode-gated.
    crashCleanupState.caller = await resolveInitialTurnCallerStep({
      serializedContext: input.serializedContext,
    });
    crashCleanupState.callerResolved = true;

    const outcome = await runDriverLoop({
      capabilities,
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
          {
            message: input.input.message,
            context: input.input.context,
            outputSchema: input.input.outputSchema,
          },
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
              workflowStartedAt.getTime() + (input.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS),
            ),
    });
    if (outcome.kind === "result") {
      return outcome.result;
    }
    return await finalizeExpiredSession({
      caller: crashCleanupState.caller,
      driverWritable,
      mode,
      serializedContext: outcome.serializedContext,
      sessionState: outcome.sessionState,
    });
  } catch (error) {
    // Safety net for failures the tool-loop harness does not already
    // surface as `session.failed` (deserialization, runtime-action
    // throws, adapter `deliver` throws, staging errors, etc.) so the
    // channel still sees a terminal event.
    if (crashCleanupState.lastSessionState !== undefined) {
      await terminateChildSessionsStep({
        serializedContext: input.serializedContext,
        sessionState: crashCleanupState.lastSessionState,
      });
    }
    await emitTerminalSessionFailureStep({
      error: normalizeSerializableError(error),
      parentWritable: driverWritable,
      serializedContext: input.serializedContext,
    });
    if (mode === "task") {
      await settleProgressWorkStep({
        outcome: "failed",
        serializedContext: input.serializedContext,
      });
      await fireSessionCallbackStep({
        error: normalizeSerializableError(error),
        serializedContext: input.serializedContext,
        status: "failed",
      });
      await notifyDelegatedParentStep({
        result: createDelegatedSubagentErrorResult(input.serializedContext, error),
        serializedContext: input.serializedContext,
      });
    } else {
      await notifyTurnCallerStep({
        caller: await resolveCallerForCrash(crashCleanupState, input.serializedContext),
        lifecycle: "terminal",
        sessionId,
        settled: { isError: true, output: error },
      });
    }
    throw createSafeOuterWorkflowError();
  }
}

async function runDriverLoop(input: {
  readonly capabilities?: SessionCapabilities;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly initialInput: HookPayload;
  readonly crashCleanupState: CrashCleanupState;
  readonly mode: RunMode;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutDeadline?: Date;
}): Promise<DriverLoopOutcome> {
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
        cancelledTaskIds,
        commandInbox,
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
  const commandInbox = createSessionCommandInbox();
  const stableCommandToken = sessionCommandHookToken(input.sessionState.sessionId);
  await commandInbox.claimStable(stableCommandToken);
  // Per-session authorization-callback hook. Claimed before any turns so it
  // exists when authorization.required events trigger OAuth callbacks;
  // getHookUrl() builds callback URLs with this token (see authHookToken —
  // inlined here because the workflow driver body cannot import the
  // harness module).
  await commandInbox.claimAuthorization(`${input.sessionState.sessionId}:auth`);
  const sessionTimeout =
    input.sessionTimeoutDeadline === undefined
      ? undefined
      : createSessionTimeoutControl({
          deadline: input.sessionTimeoutDeadline,
          token: stableCommandToken,
        });

  // Durable state accumulated across turns and the parked waits between
  // them. Turn results and settle/routing steps are adopted here, so the
  // loop never threads `serializedContext`/`sessionState` pairs by hand.
  const stateCursor = new SessionStateCursor({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });

  // Control-hook disposal is deferred one turn — see DispatchedTurn.
  let disposeSettledTurnControl: (() => Promise<void>) | undefined;
  const runTurn = async (delivery: HookPayload): Promise<TurnDriverAction> => {
    const caller = input.crashCleanupState.caller;
    if (caller?.taskId !== undefined) {
      seenTaskDeliveries.add(caller.taskId);
      await notifyTaskTurnStartedStep({
        caller,
        childSessionId: stateCursor.sessionState.sessionId,
        childTurnId: activeTurnId(stateCursor.sessionState.emissionState),
      });
    }
    const serializedContext = await bindTurnCallerContextStep({
      caller,
      serializedContext: stateCursor.serializedContext,
    });
    const turn = await dispatchAndAwaitTurn({
      bufferedDeliveries,
      bufferedSessionControls,
      cancelledTaskIds,
      capabilities: input.capabilities,
      commandInbox,
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
    stateCursor.adoptState(turn.action);
    input.crashCleanupState.lastSessionState = stateCursor.sessionState;
    return turn.action;
  };

  try {
    if (input.sessionState.continuationToken) {
      try {
        await commandInbox.rekeyContinuation(input.sessionState.continuationToken);
      } catch (error) {
        // A concurrent create can start two candidate runs before either
        // publishes the shared continuation alias. The runtime adopts the
        // alias owner; the losing candidate must exit before its first turn
        // instead of emitting a second session failure for the same create.
        if (!isHookConflictError(error)) throw error;
        return { kind: "result", result: { output: "" } };
      }
    }
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
        await settleProgressWorkStep({
          outcome: settled.isError === true ? "failed" : "completed",
          serializedContext: stateCursor.serializedContext,
        });
        await notifyTurnCallerStep({
          caller: input.crashCleanupState.caller,
          lifecycle: "parked",
          sessionId: stateCursor.sessionState.sessionId,
          settled,
        });
        input.crashCleanupState.caller = undefined;
      } else if (action.cancelled === true) {
        await settleProgressWorkStep({
          outcome: "cancelled",
          serializedContext: stateCursor.serializedContext,
        });
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
        await terminateChildSessionsStep({
          serializedContext: stateCursor.serializedContext,
          sessionState: stateCursor.sessionState,
        });
        return { kind: "result", result: { output: "" } };
      }

      if (next.kind === "clear" || next.kind === "compact") {
        action = await runTurn({ kind: next.kind });
        continue;
      }

      if (next.kind === "closed") {
        await terminateChildSessionsStep({
          serializedContext: stateCursor.serializedContext,
          sessionState: stateCursor.sessionState,
        });
        return { kind: "result", result: { output: "" } };
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
    await commandInbox.dispose();
  }
}

async function finalizeExpiredSession(input: {
  readonly caller: TurnCaller | undefined;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly mode: RunMode;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<WorkflowEntryResult> {
  await terminateChildSessionsStep({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  await emitTerminalSessionCompletionStep({
    parentWritable: input.driverWritable,
    serializedContext: input.serializedContext,
  });

  if (input.mode === "task") {
    await settleProgressWorkStep({
      outcome: "completed",
      serializedContext: input.serializedContext,
    });
    await fireSessionCallbackStep({
      output: "",
      serializedContext: input.serializedContext,
      status: "completed",
    });
    await notifyDelegatedParentStep({
      result: createDelegatedSubagentSuccessResult(input.serializedContext, ""),
      serializedContext: input.serializedContext,
    });
  } else {
    await notifyTurnCallerStep({
      caller: input.caller,
      lifecycle: "terminal",
      sessionId: input.sessionState.sessionId,
      settled: { output: "" },
    });
  }
  return { output: "" };
}

async function finalizeDone(input: {
  readonly action: NextDriverAction & { readonly kind: "done" };
  readonly caller: TurnCaller | undefined;
  readonly mode: RunMode;
}): Promise<WorkflowEntryResult> {
  const { output, serializedContext } = input.action;
  const failed = input.action.isError === true;

  await terminateChildSessionsStep({
    serializedContext,
    sessionState: input.action.sessionState,
  });
  if (input.mode === "task") {
    await settleProgressWorkStep({
      outcome: failed ? "failed" : "completed",
      serializedContext,
    });
    await fireSessionCallbackStep({
      error: failed ? output : undefined,
      output: failed ? undefined : output,
      serializedContext,
      status: failed ? "failed" : "completed",
      usage: input.action.usage,
    });
    await notifyDelegatedParentStep({
      result: failed
        ? createDelegatedSubagentErrorResult(serializedContext, output)
        : createDelegatedSubagentSuccessResult(serializedContext, output),
      serializedContext,
      usage: input.action.usage,
    });
  } else {
    const settled: {
      isError?: boolean;
      output: unknown;
      usage?: TokenUsage;
    } = { output, usage: input.action.usageDelta };
    if (failed) {
      settled.isError = true;
    }
    await notifyTurnCallerStep({
      caller: input.caller,
      lifecycle: "terminal",
      sessionId: input.action.sessionState.sessionId,
      settled,
    });
  }
  return { output };
}
