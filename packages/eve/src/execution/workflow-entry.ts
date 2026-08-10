import { createHook, getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

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
  notifyDelegatedParentStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#execution/delegated-parent-notification.js";
import {
  createDelegatedSubagentErrorResult,
  createDelegatedSubagentSuccessResult,
} from "#execution/delegated-parent-result.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { nextTurnDelivery } from "#execution/parked-delivery-wait.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { dispatchAndAwaitTurn } from "#execution/turn-dispatch.js";
import type { TurnDriverAction } from "#execution/turn-control-receiver.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";
import { disposeHook } from "#execution/hook-ownership.js";
import { createSessionCommandInbox } from "#execution/session-command-inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session-timeout.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { createSessionTimeoutControl } from "#execution/session-timeout-control.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { readSerializedSubagentDepth } from "#harness/subagent-depth.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import type { TokenUsage } from "#shared/token-usage.js";

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
  readonly forwardedSubagentStream?: RunInput["forwardedSubagentStream"];
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
      forwardedSubagentStream: input.forwardedSubagentStream,
      initialInput: {
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
        sessionState: crashCleanupState.lastSessionState,
      });
    }
    await emitTerminalSessionFailureStep({
      error: normalizeSerializableError(error),
      parentWritable: driverWritable,
      serializedContext: input.serializedContext,
    });
    if (mode === "task") {
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
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly forwardedSubagentStream?: RunInput["forwardedSubagentStream"];
  readonly initialInput: HookPayload;
  readonly crashCleanupState: CrashCleanupState;
  readonly mode: RunMode;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutDeadline?: Date;
}): Promise<DriverLoopOutcome> {
  // Per-session auth hook. Created before any turns so it exists
  // when authorization.required events trigger OAuth callbacks.
  // getHookUrl() builds callback URLs with this token.
  const authHook = createHook<HookPayload>({
    token: `${input.sessionState.sessionId}:auth`,
  });
  const authIterator: AsyncIterator<HookPayload> = authHook[Symbol.asyncIterator]();
  // Fast descendant resumes can start the next turn before the prior
  // control hook disposal is persisted by the Workflow SDK, so each
  // turn needs its own session-scoped token.
  let turnDispatchIndex = 0;
  const nextTurnControlToken = (): string =>
    `${input.sessionState.sessionId}:turn-control:${String(turnDispatchIndex++)}`;

  const bufferedDeliveries: DeliverHookPayload[] = [];
  const bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset"> = [];
  const commandInbox = createSessionCommandInbox();
  const stableCommandToken = sessionCommandHookToken(input.sessionState.sessionId);
  await commandInbox.claimStable(stableCommandToken);
  const sessionTimeout =
    input.sessionTimeoutDeadline === undefined
      ? undefined
      : createSessionTimeoutControl({
          deadline: input.sessionTimeoutDeadline,
          token: stableCommandToken,
        });

  // Control-hook disposal is deferred one turn — see DispatchedTurn.
  let disposeSettledTurnControl: (() => Promise<void>) | undefined;
  const runTurn = async (args: {
    readonly delivery: HookPayload;
    readonly forwardedSubagentStream?: RunInput["forwardedSubagentStream"];
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
  }): Promise<TurnDriverAction> => {
    const turn = await dispatchAndAwaitTurn({
      bufferedDeliveries,
      bufferedSessionControls,
      capabilities: input.capabilities,
      commandInbox,
      controlToken: nextTurnControlToken(),
      delivery: args.delivery,
      mode: input.mode,
      parentWritable: input.driverWritable,
      forwardedSubagentStream: args.forwardedSubagentStream,
      serializedContext: args.serializedContext,
      sessionState: args.sessionState,
    });
    await disposeSettledTurnControl?.();
    disposeSettledTurnControl = turn.dispose;
    return turn.action;
  };

  try {
    if (input.sessionState.continuationToken) {
      await commandInbox.rekeyContinuation(input.sessionState.continuationToken);
    }
    await sessionTimeout?.start();

    let action: TurnDriverAction = await runTurn({
      delivery: input.initialInput,
      forwardedSubagentStream: input.forwardedSubagentStream,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    });
    input.crashCleanupState.lastSessionState = action.sessionState;

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
          serializedContext: action.serializedContext,
          sessionState: action.sessionState,
        });
        action = {
          ...action,
          serializedContext: settled.serializedContext,
          sessionState: settled.sessionState,
        };
        input.crashCleanupState.lastSessionState = action.sessionState;
      }

      // Channel-created sessions may rekey their dynamic alias. Sessions
      // without one remain reachable through the stable command inbox only.
      if (action.sessionState.continuationToken) {
        await commandInbox.rekeyContinuation(action.sessionState.continuationToken);
      }

      if (action.authorizationNames && action.authorizationNames.length > 0) {
        const expected = action.authorizationNames.length;
        const allPayloads: DeliverPayload[] = [];

        while (allPayloads.length < expected) {
          const next = await authIterator.next();
          if (next.done) break;
          if (next.value.kind === "deliver") {
            allPayloads.push(...next.value.payloads);
          }
        }

        action = await runTurn({
          delivery: {
            kind: "deliver",
            payloads: allPayloads,
          },
          forwardedSubagentStream: input.forwardedSubagentStream,
          serializedContext: action.serializedContext,
          sessionState: action.sessionState,
        });
        input.crashCleanupState.lastSessionState = action.sessionState;
        continue;
      }

      // `settled` rides the typed park arm exclusively; `run-step` preserves
      // the full StepResult so no state-key fallback exists anymore.
      const settled = action.settled;
      if (action.cancelled !== true && settled !== undefined) {
        await notifyTurnCallerStep({
          caller: input.crashCleanupState.caller,
          lifecycle: "parked",
          sessionId: action.sessionState.sessionId,
          settled,
        });
        input.crashCleanupState.caller = undefined;
      } else if (action.cancelled === true) {
        input.crashCleanupState.caller = undefined;
      }

      const next = await nextTurnDelivery({
        bufferedDeliveries,
        bufferedSessionControls,
        commandInbox,
        driverWritable: input.driverWritable,
        sessionState: action.sessionState,
      });

      if (next.kind === "expired") {
        return {
          kind: "expired",
          serializedContext: action.serializedContext,
          sessionState: action.sessionState,
        };
      }

      if (next.kind === "reset") {
        await terminateChildSessionsStep({ sessionState: action.sessionState });
        return { kind: "result", result: { output: "" } };
      }

      if (next.kind === "clear" || next.kind === "compact") {
        action = await runTurn({
          delivery: { kind: next.kind },
          serializedContext: action.serializedContext,
          sessionState: action.sessionState,
        });
        input.crashCleanupState.lastSessionState = action.sessionState;
        continue;
      }

      if (next.kind === "closed") {
        return { kind: "result", result: { output: "" } };
      }

      if (next.kind === "cancel-turn") {
        await cancelDescendantTurnsStep({
          serializedContext: action.serializedContext,
          sessionState: action.sessionState,
        });
        const cancelled = await settleCancelledTurnStep({
          parentWritable: input.driverWritable,
          serializedContext: action.serializedContext,
          sessionState: action.sessionState,
        });
        // Re-enter with `settled` cleared: the parked answer was already
        // delivered to its caller before this wait, so the next iteration
        // must not treat it as a fresh settlement.
        action = {
          ...action,
          serializedContext: cancelled.serializedContext,
          sessionState: cancelled.sessionState,
          settled: undefined,
        };
        input.crashCleanupState.caller = undefined;
        input.crashCleanupState.lastSessionState = action.sessionState;
        continue;
      }

      if (next.deliver.caller !== undefined) {
        input.crashCleanupState.caller = next.deliver.caller;
      }
      action = await runTurn({
        delivery: {
          auth: next.deliver.auth,
          kind: "deliver",
          payloads: [next.remainder],
          requestId: next.deliver.requestId,
        },
        forwardedSubagentStream: input.forwardedSubagentStream,
        serializedContext: action.serializedContext,
        sessionState: action.sessionState,
      });
      input.crashCleanupState.lastSessionState = action.sessionState;
    }
  } finally {
    await disposeSettledTurnControl?.();
    await sessionTimeout?.dispose();
    await commandInbox.dispose();
    // Dispose without closing the iterator: a session cancelled while
    // awaiting authorization can leave a durable read in flight, and an
    // async iterator only honors `return()` after that read settles.
    await disposeHook(authHook);
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
    sessionState: input.sessionState,
  });
  await emitTerminalSessionCompletionStep({
    parentWritable: input.driverWritable,
    serializedContext: input.serializedContext,
  });

  if (input.mode === "task") {
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
    sessionState: input.action.sessionState,
  });
  if (input.mode === "task") {
    await fireSessionCallbackStep({
      error: failed ? output : undefined,
      output: failed ? undefined : output,
      serializedContext,
      status: failed ? "failed" : "completed",
      usage: failed ? undefined : input.action.usage,
    });
    await notifyDelegatedParentStep({
      result: failed
        ? createDelegatedSubagentErrorResult(serializedContext, output)
        : createDelegatedSubagentSuccessResult(serializedContext, output),
      serializedContext,
      usage: failed ? undefined : input.action.usage,
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
