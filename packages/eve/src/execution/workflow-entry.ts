import {
  createHook,
  getWorkflowMetadata,
  getWritable,
  type Hook,
} from "#compiled/@workflow/core/index.js";

import type {
  DeliverHookPayload,
  DeliverPayload,
  HookPayload,
  RunInput,
  SessionCapabilities,
} from "#channel/types.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { readRootSessionId } from "#execution/eve-workflow-attributes.js";
import { accumulateRuntimeActionResults } from "#harness/runtime-actions.js";
import type { RunMode } from "#shared/run-mode.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { InputResponse } from "#runtime/input/types.js";
import { notifyDelegatedParentStep } from "#execution/delegated-parent-notification.js";
import {
  createDelegatedSubagentErrorResult,
  createDelegatedSubagentSuccessResult,
} from "#execution/delegated-parent-result.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { TurnCompletionPayload } from "#execution/turn-workflow.js";
import {
  normalizeSerializableError,
  rebuildSerializableError,
} from "#execution/workflow-errors.js";
import { resolveVercelProductionCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { dispatchCodeModeRuntimeActionsStep } from "#execution/dispatch-code-mode-runtime-actions-step.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import {
  dispatchTurnStep,
  emitTerminalSessionFailureStep,
  routeProxiedDeliverStep,
  runProxyInputRequestStep,
} from "#execution/workflow-steps.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";

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
  readonly serializedContext: Record<string, unknown>;
}

export interface WorkflowEntryResult {
  readonly output: unknown;
}

/**
 * Long-lived workflow entrypoint. Handles both root sessions and
 * delegated child sessions: root sessions expose only parent
 * control-plane events; delegated children publish their full progress
 * on a child stream and resume the parked parent with a
 * `subagent-result` on completion.
 *
 * Dispatches on the closed-contract {@link NextDriverAction} returned
 * by each step. The only session-shape flag the driver reads (besides
 * identity) is `hasProxyInputRequests`, the documented short-circuit
 * for hook-payload routing.
 */
export async function workflowEntry(input: WorkflowEntryInput): Promise<WorkflowEntryResult> {
  "use workflow";

  const { workflowRunId: sessionId } = getWorkflowMetadata();
  const continuationToken = (input.serializedContext["eve.continuationToken"] as string) || "";
  const mode = input.serializedContext["eve.mode"] as RunMode;
  const capabilities = input.serializedContext["eve.capabilities"] as
    | SessionCapabilities
    | undefined;
  const serializedBundle = input.serializedContext["eve.bundle"] as {
    source: RuntimeCompiledArtifactsSource;
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

    // `createSessionStep` emits the session/subagent-root `$eve.*` tags
    // from inside its own step body (see create-session-step.ts), so no
    // separate attribute step is spent here in the workflow body.
    const { state: sessionState } = await createSessionStep({
      compiledArtifactsSource: serializedBundle.source,
      continuationToken,
      inputMessage: input.input.message,
      nodeId: serializedBundle.nodeId,
      outputSchema: input.input.outputSchema,
      rootSessionId: rootSessionIdFromParent,
      serializedContext: input.serializedContext,
      sessionId,
    });

    return await runDriverLoop({
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
      },
      mode,
      serializedContext: input.serializedContext,
      sessionState,
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
    throw error;
  }
}

async function runDriverLoop(input: {
  readonly capabilities?: SessionCapabilities;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly initialInput: HookPayload;
  readonly mode: RunMode;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<WorkflowEntryResult> {
  // Per-session auth hook. Created before any turns so it exists
  // when authorization.required events trigger OAuth callbacks.
  // getHookUrl() builds callback URLs with this token.
  const authHook = createHook<HookPayload>({
    token: `${input.sessionState.sessionId}:auth`,
  });
  const authIterator: AsyncIterator<HookPayload> = authHook[Symbol.asyncIterator]();
  // Fast descendant resumes can start the next turn before the prior
  // completion hook disposal is persisted by the Workflow SDK, so each
  // turn needs its own session-scoped token.
  let turnDispatchIndex = 0;
  const nextTurnCompletionToken = (): string =>
    `${input.sessionState.sessionId}:turn-completion:${String(turnDispatchIndex++)}`;

  // Register before the first turn when a placeholder token exists.
  // Tokenless channels must anchor during that turn before hook registration.
  let parkToken = "";
  let hook: Hook<HookPayload> | undefined;
  let iterator: AsyncIterator<HookPayload> | undefined;
  let pendingNext: Promise<IteratorResult<HookPayload>> | null = null;
  const bufferedDeliveries: DeliverHookPayload[] = [];

  const createParkHook = (nextToken: string): void => {
    parkToken = nextToken;
    hook = createHook<HookPayload>({ token: parkToken });
    iterator = hook[Symbol.asyncIterator]();
    pendingNext = null;
  };

  if (input.sessionState.continuationToken) {
    createParkHook(input.sessionState.continuationToken);
  }

  const getNextPromise = (): Promise<IteratorResult<HookPayload>> => {
    if (iterator === undefined) {
      throw new Error("Cannot wait for deliveries before a continuation token is available.");
    }

    pendingNext ??= iterator.next();
    return pendingNext;
  };

  const consumeNext = (): void => {
    pendingNext = null;
  };

  /**
   * Disposes the current park hook and creates a fresh one at
   * `nextToken`. Channels that re-key mid-session must coordinate
   * with their senders — in-flight deliveries to the old token after
   * this returns are silently dropped.
   */
  const closeParkHook = async (): Promise<void> => {
    if (iterator !== undefined) {
      await closeHookIterator(iterator);
    }
    if (hook !== undefined) {
      await disposeHook(hook);
    }
    hook = undefined;
    iterator = undefined;
    pendingNext = null;
  };

  const rekeyHook = async (nextToken: string): Promise<void> => {
    if (!nextToken || (hook !== undefined && nextToken === parkToken)) return;
    await closeParkHook();
    createParkHook(nextToken);
  };

  let action: NextDriverAction = await dispatchAndAwaitTurn({
    capabilities: input.capabilities,
    completionToken: nextTurnCompletionToken(),
    delivery: input.initialInput,
    mode: input.mode,
    parentWritable: input.driverWritable,
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });

  if (action.kind === "done") {
    await closeHookIterator(authIterator);
    await disposeHook(authHook);
    await closeParkHook();
    return await finalizeDone({
      action,
      driverWritable: input.driverWritable,
    });
  }

  if (!action.sessionState.continuationToken) {
    await closeHookIterator(authIterator);
    await disposeHook(authHook);
    await closeParkHook();
    throw new Error(
      "Cannot park: no continuation token available. The channel must " +
        "post the first message during the initial turn (anchoring the " +
        "session) or `send()` must be called with an explicit " +
        "continuationToken.",
    );
  }

  // Rekey if the first turn changed the continuation token.
  await rekeyHook(action.sessionState.continuationToken);

  try {
    while (true) {
      switch (action.kind) {
        case "done":
          return await finalizeDone({
            action,
            driverWritable: input.driverWritable,
          });

        case "dispatch-code-mode-runtime-actions":
        case "dispatch-runtime-actions": {
          const dispatchStep =
            action.kind === "dispatch-code-mode-runtime-actions"
              ? dispatchCodeModeRuntimeActionsStep
              : dispatchRuntimeActionsStep;

          const dispatchResult = await dispatchStep({
            callbackBaseUrl: resolveVercelProductionCallbackBaseUrl() ?? getWorkflowMetadata().url,
            parentWritable: input.driverWritable,
            serializedContext: action.serializedContext,
            sessionState: action.sessionState,
          });

          const runtimeResults = await waitForPendingRuntimeActionResults({
            bufferedDeliveries,
            consumeNext,
            getNextPromise,
            initialResults: dispatchResult.results,
            parentWritable: input.driverWritable,
            pendingActionKeys: action.pendingActionKeys,
            rekeyHook,
            serializedContext: action.serializedContext,
            sessionState: dispatchResult.sessionState,
          });

          if (runtimeResults === null) {
            return { output: "" };
          }

          action = await dispatchAndAwaitTurn({
            capabilities: input.capabilities,
            completionToken: nextTurnCompletionToken(),
            delivery: {
              kind: "runtime-action-result",
              results: runtimeResults.results,
            },
            mode: input.mode,
            parentWritable: input.driverWritable,
            serializedContext: runtimeResults.serializedContext,
            sessionState: runtimeResults.sessionState,
          });

          await rekeyHook(action.sessionState.continuationToken);
          break;
        }

        case "park": {
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

            action = await dispatchAndAwaitTurn({
              capabilities: input.capabilities,
              completionToken: nextTurnCompletionToken(),
              delivery: {
                kind: "deliver",
                payloads: allPayloads,
              },
              mode: input.mode,
              parentWritable: input.driverWritable,
              serializedContext: action.serializedContext,
              sessionState: action.sessionState,
            });

            await rekeyHook(action.sessionState.continuationToken);
            break;
          }

          const nextDeliver = await waitForNextDeliver({
            bufferedDeliveries,
            consumeNext,
            getNextPromise,
          });

          if (nextDeliver === null) {
            return { output: "" };
          }

          const remainder = await routeDeliverForChildren({
            auth: nextDeliver.auth,
            parentWritable: input.driverWritable,
            payloads: nextDeliver.payloads,
            sessionState: action.sessionState,
          });

          if (remainder === undefined) {
            // Fully routed to a descendant; parent has no turn to run.
            continue;
          }

          action = await dispatchAndAwaitTurn({
            capabilities: input.capabilities,
            completionToken: nextTurnCompletionToken(),
            delivery: {
              auth: nextDeliver.auth,
              kind: "deliver",
              payloads: [remainder],
            },
            mode: input.mode,
            parentWritable: input.driverWritable,
            serializedContext: action.serializedContext,
            sessionState: action.sessionState,
          });

          await rekeyHook(action.sessionState.continuationToken);
          break;
        }
      }
    }
  } finally {
    await closeParkHook();
    await closeHookIterator(authIterator);
    await disposeHook(authHook);
  }
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
  });
  await notifyDelegatedParentStep({
    result: failed
      ? createDelegatedSubagentErrorResult(serializedContext, output)
      : createDelegatedSubagentSuccessResult(serializedContext, output),
    serializedContext,
  });
  return { output };
}

async function dispatchAndAwaitTurn(input: {
  readonly capabilities?: SessionCapabilities;
  readonly completionToken: string;
  readonly delivery: HookPayload;
  readonly mode: RunMode;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<NextDriverAction> {
  const completion = createHook<TurnCompletionPayload>({ token: input.completionToken });
  const completionToken = completion.token;

  try {
    await dispatchTurnStep({
      capabilities: input.capabilities,
      completionToken,
      delivery: input.delivery,
      mode: input.mode,
      parentWritable: input.parentWritable,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    });

    const payload = await awaitHookPayload(completion);

    if (payload.kind === "turn-error") {
      throw rebuildSerializableError(payload.error);
    }

    return payload.action;
  } finally {
    await disposeHook(completion);
  }
}

async function awaitHookPayload<T>(hook: Hook<T>): Promise<T> {
  for await (const value of hook) {
    return value;
  }
  throw new Error("Turn completion hook closed before delivering a result.");
}

interface PendingRuntimeActionResultsOutcome {
  readonly results: readonly RuntimeSubagentResultActionResult[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

async function waitForPendingRuntimeActionResults(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly consumeNext: () => void;
  readonly getNextPromise: () => Promise<IteratorResult<HookPayload>>;
  readonly initialResults?: readonly RuntimeSubagentResultActionResult[];
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly pendingActionKeys: readonly string[];
  readonly rekeyHook: (nextToken: string) => Promise<void>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<PendingRuntimeActionResultsOutcome | null> {
  let currentSessionState = input.sessionState;
  // Thread the post-proxy serialized context forward so subsequent
  // deliveries and the post-wait `turnStep` observe adapter-state
  // mutations (e.g. Slack's `pendingRequests` cache).
  let currentSerializedContext = input.serializedContext;

  const results = await accumulateRuntimeActionResults({
    bufferedDeliveries: input.bufferedDeliveries,
    async getNext() {
      while (true) {
        const next = await input.getNextPromise();
        input.consumeNext();

        if (next.done) {
          return null;
        }

        const value = next.value;

        if (value.kind === "deliver") {
          // Route descendant-bound `inputResponses` down to the owning
          // child before buffering — otherwise the response would sit
          // in the buffer until the child completes, which it cannot
          // do without the response (parent↔child deadlock).
          const remainder = await routeDeliverForChildren({
            auth: value.auth,
            parentWritable: input.parentWritable,
            payloads: value.payloads,
            sessionState: currentSessionState,
          });

          if (remainder === undefined) {
            // Fully proxied; keep waiting.
            continue;
          }

          return {
            kind: "deliver",
            value: { ...value, payloads: [remainder] },
          };
        }

        if (value.kind === "runtime-action-result") {
          return { kind: "runtime-action-result", results: value.results };
        }

        // subagent-input-request: proxy the child's HITL through the
        // parent's adapter, record the routing entry, keep waiting.
        const proxyResult = await runProxyInputRequestStep({
          hookPayload: value,
          parentWritable: input.parentWritable,
          serializedContext: currentSerializedContext,
          sessionState: currentSessionState,
        });
        currentSessionState = proxyResult.sessionState;
        currentSerializedContext = proxyResult.serializedContext;
        await input.rekeyHook(currentSessionState.continuationToken);
      }
    },
    initialResults: input.initialResults,
    pendingActionKeys: input.pendingActionKeys,
  });

  if (results === null) {
    return null;
  }

  return {
    results: results as readonly RuntimeSubagentResultActionResult[],
    serializedContext: currentSerializedContext,
    sessionState: currentSessionState,
  };
}

/**
 * Routes one inbound deliver down to descendant subagents with
 * matching proxied HITL requests. Returns the parent-local remainder
 * (or `undefined` when the entire payload was routed away).
 *
 * Short-circuits via `hasProxyInputRequests` so the common
 * no-active-descendant path skips a durable step boundary.
 */
async function routeDeliverForChildren(input: {
  readonly auth: DeliverHookPayload["auth"];
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payloads: readonly DeliverPayload[];
  readonly sessionState: DurableSessionState;
}): Promise<DeliverPayload | undefined> {
  const coalesced = coalescePayloads(input.payloads);

  if (!input.sessionState.hasProxyInputRequests) {
    return coalesced;
  }

  const routed = await routeProxiedDeliverStep({
    auth: input.auth,
    parentWritable: input.parentWritable,
    payload: coalesced,
    sessionState: input.sessionState,
  });

  return routed.remainder;
}

async function waitForNextDeliver(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly consumeNext: () => void;
  readonly getNextPromise: () => Promise<IteratorResult<HookPayload>>;
}): Promise<DeliverHookPayload | null> {
  if (input.bufferedDeliveries.length > 0) {
    return coalesceDeliveries(input.bufferedDeliveries.splice(0));
  }

  while (true) {
    const first = await input.getNextPromise();
    input.consumeNext();

    if (first.done) {
      return null;
    }

    if (first.value.kind !== "deliver") {
      continue;
    }

    let coalesced = first.value;

    while (true) {
      const ready = await takeReadyPayload(input.getNextPromise());

      if (ready === NO_READY_MESSAGE) {
        break;
      }

      input.consumeNext();

      if (ready.done) {
        break;
      }

      if (ready.value.kind !== "deliver") {
        continue;
      }

      coalesced = coalesceDeliveries([coalesced, ready.value]);
    }

    return coalesced;
  }
}

function coalescePayloads(payloads: readonly DeliverPayload[]): DeliverPayload {
  if (payloads.length === 0) {
    return {};
  }

  if (payloads.length === 1) {
    return payloads[0] ?? {};
  }

  const merged: Record<string, unknown> = {};
  const inputResponses: InputResponse[] = [];

  for (const payload of payloads) {
    for (const [key, value] of Object.entries(payload)) {
      if (key === "inputResponses") {
        continue;
      }

      if (value !== undefined) {
        merged[key] = value;
      }
    }

    if (payload.inputResponses !== undefined) {
      inputResponses.push(...payload.inputResponses);
    }
  }

  if (inputResponses.length > 0) {
    merged.inputResponses = inputResponses;
  }

  return merged as DeliverPayload;
}

const NO_READY_MESSAGE = Symbol("no-ready-message");

async function takeReadyPayload<T>(promise: Promise<T>): Promise<T | typeof NO_READY_MESSAGE> {
  await Promise.resolve();
  return await Promise.race([promise, Promise.resolve(NO_READY_MESSAGE)]);
}

async function closeHookIterator(iterator: AsyncIterator<HookPayload>): Promise<void> {
  if (typeof iterator.return !== "function") {
    return;
  }

  await iterator.return(undefined);
}

async function disposeHook(hook: {
  dispose?: () => unknown;
  [Symbol.dispose]?: () => unknown;
}): Promise<void> {
  const explicitDispose = hook.dispose;
  if (typeof explicitDispose === "function") {
    await explicitDispose.call(hook);
    return;
  }

  const symbolDispose = hook[Symbol.dispose];
  if (typeof symbolDispose !== "function") {
    return;
  }

  await symbolDispose.call(hook);
}
