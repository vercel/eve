import { createHook, getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

import type {
  DeliverHookPayload,
  DeliverPayload,
  HookPayload,
  RunInput,
  SessionCapabilities,
} from "#channel/types.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { readChannelRequestId, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import type { RunMode } from "#shared/run-mode.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { notifyDelegatedParentStep } from "#execution/delegated-parent-notification.js";
import {
  createDelegatedSubagentErrorResult,
  createDelegatedSubagentSuccessResult,
} from "#execution/delegated-parent-result.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { dispatchAndAwaitTurn } from "#execution/turn-dispatch.js";
import type { TurnDriverAction } from "#execution/turn-control-receiver.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";
import { disposeHook } from "#execution/hook-ownership.js";
import {
  createSessionCommandInbox,
  type SessionCommandInbox,
} from "#execution/session-command-inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session-timeout.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { createSessionTimeoutControl } from "#execution/session-timeout-control.js";
import { readSerializedSubagentDepth } from "#harness/subagent-depth.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";

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
    }
  | {
      readonly kind: "result";
      readonly result: WorkflowEntryResult;
    };

type NextSessionAction =
  | { readonly kind: "clear" }
  | { readonly kind: "compact" }
  | {
      readonly delivery: DeliverHookPayload | null;
      readonly kind: "delivery";
    }
  | { readonly kind: "expired" }
  | { readonly kind: "reset" };

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

    const outcome = await runDriverLoop({
      capabilities,
      driverWritable,
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
      driverWritable,
      serializedContext: outcome.serializedContext,
    });
  } catch (error) {
    // Safety net for failures the tool-loop harness does not already
    // surface as `session.failed` (deserialization, runtime-action
    // throws, adapter `deliver` throws, staging errors, etc.) so the
    // channel still sees a terminal event.
    await emitTerminalSessionFailureStep({
      error: normalizeSerializableError(error),
      parentWritable: driverWritable,
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
    throw createSafeOuterWorkflowError();
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
  readonly initialInput: HookPayload;
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
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    });

    while (true) {
      if (action.kind === "done") {
        return {
          kind: "result",
          result: await finalizeDone({
            action,
            driverWritable: input.driverWritable,
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
          serializedContext: action.serializedContext,
          sessionState: action.sessionState,
        });
        continue;
      }

      const nextAction = await waitForNextSessionAction({
        bufferedDeliveries,
        bufferedSessionControls,
        commandInbox,
      });

      if (nextAction.kind === "expired") {
        return {
          kind: "expired",
          serializedContext: action.serializedContext,
        };
      }

      if (nextAction.kind === "reset") {
        return { kind: "result", result: { output: "" } };
      }

      if (nextAction.kind === "clear" || nextAction.kind === "compact") {
        action = await runTurn({
          delivery: { kind: nextAction.kind },
          serializedContext: action.serializedContext,
          sessionState: action.sessionState,
        });
        continue;
      }

      const nextDeliver = nextAction.delivery;
      if (nextDeliver === null) {
        return { kind: "result", result: { output: "" } };
      }

      const routed = await routeDeliverToChildren({
        auth: nextDeliver.auth,
        parentWritable: input.driverWritable,
        payloads: nextDeliver.payloads,
        sessionState: action.sessionState,
      });

      if (routed.kind === "cancel-turn") {
        await cancelDescendantTurnsStep({
          serializedContext: action.serializedContext,
          sessionState: action.sessionState,
        });
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
        continue;
      }

      if (routed.remainder === undefined) {
        // Fully routed to a descendant; parent has no turn to run.
        continue;
      }

      action = await runTurn({
        delivery: {
          auth: nextDeliver.auth,
          kind: "deliver",
          payloads: [routed.remainder],
          requestId: nextDeliver.requestId,
        },
        serializedContext: action.serializedContext,
        sessionState: action.sessionState,
      });
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

async function waitForNextSessionAction(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly commandInbox: SessionCommandInbox;
}): Promise<NextSessionAction> {
  const pendingSessionControl = input.bufferedSessionControls.shift();
  if (pendingSessionControl !== undefined) {
    return { kind: pendingSessionControl };
  }

  if (input.bufferedDeliveries.length > 0) {
    return {
      delivery: coalesceDeliveries(input.bufferedDeliveries.splice(0)),
      kind: "delivery",
    };
  }

  while (true) {
    const first = await input.commandInbox.next();
    input.commandInbox.consumeNext();

    if (first.done) {
      return { delivery: null, kind: "delivery" };
    }

    if (first.value.kind === "session-timeout") {
      return { kind: "expired" };
    }

    if (
      first.value.kind === "clear" ||
      first.value.kind === "compact" ||
      first.value.kind === "reset"
    ) {
      return { kind: first.value.kind };
    }

    if (first.value.kind === "cancel") {
      continue;
    }

    return { delivery: commandToDelivery(first.value), kind: "delivery" };
  }
}

function commandToDelivery(
  command: Extract<import("#channel/types.js").SessionCommand, { readonly kind: "send" }>,
): DeliverHookPayload {
  return {
    auth: command.auth,
    caller: command.caller,
    kind: "deliver",
    payloads: [command.payload],
    requestId: command.requestId,
  };
}

async function finalizeExpiredSession(input: {
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
}): Promise<WorkflowEntryResult> {
  await emitTerminalSessionCompletionStep({
    parentWritable: input.driverWritable,
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
  return { output: "" };
}

async function finalizeDone(input: {
  readonly action: NextDriverAction & { readonly kind: "done" };
  readonly driverWritable: WritableStream<Uint8Array>;
}): Promise<WorkflowEntryResult> {
  const { output, serializedContext } = input.action;
  const failed = input.action.isError === true;

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
  return { output };
}
