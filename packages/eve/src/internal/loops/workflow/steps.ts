import type { DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import {
  createTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowDispatchInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { routeDeliverPayload } from "#execution/subagent-hitl-proxy.js";
import { executeTurnStepOperation } from "#internal/loops/turn-step-operation.js";
import type { TurnStepResult } from "#internal/loops/types.js";
import { buildTurnAttributes, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import {
  createWorkflowRuntime,
  startWorkflowPreferLatest,
  turnWorkflowReference,
} from "#internal/loops/workflow/runtime.js";
import { resumeHook } from "#internal/workflow/runtime.js";

export type { TurnStepInput, TurnStepResult };
export { resolveEffectiveOutputSchema } from "#internal/loops/turn-step-operation.js";

/**
 * Runs one atomic harness step inside a durable `"use step"` boundary.
 *
 * The step body lives in the engine-neutral
 * {@link import("#internal/loops/turn-step-operation.js").executeTurnStepOperation};
 * this shell owns what only the Workflow engine can supply: the durable
 * commit boundary, the pre-read of legacy session state, the callback base
 * URL from workflow metadata, the runtime constructor for delegated child
 * runs, and the workflow-run attribute writer.
 */
export async function turnStep(rawInput: TurnStepInput): Promise<TurnStepResult> {
  "use step";

  const durableSession = await readDurableSession(rawInput.sessionState);

  // Prefer eve's active local origin over metadata fallback so
  // getHookUrl() works during tool execution.
  let callbackBaseUrl: string | undefined;
  try {
    const { getWorkflowMetadata } = await import("#compiled/@workflow/core/index.js");
    const metadata = getWorkflowMetadata();
    if (typeof metadata.url === "string") {
      callbackBaseUrl = resolveWorkflowCallbackBaseUrl(metadata.url);
    }
  } catch {
    // Outside a workflow context (e.g. tests) — getHookUrl will return undefined.
  }

  return await executeTurnStepOperation({
    abortSignal: rawInput.abortSignal,
    callbackBaseUrl,
    createRuntime: createWorkflowRuntime,
    durableSession,
    input: rawInput.input,
    parentWritable: rawInput.parentWritable,
    serializedContext: rawInput.serializedContext,
    sessionState: rawInput.sessionState,
    writeEveAttributes: setEveAttributes,
  });
}

export interface RoutedDeliverResult {
  /** `undefined` when the entire payload was routed to descendants. */
  readonly remainder: DeliverPayload | undefined;
}

/**
 * Splits an inbound deliver payload into parent-local and
 * proxied-child buckets and forwards the child buckets via
 * `resumeHook`. Read-only: never appends a snapshot.
 */
export async function routeProxiedDeliverStep(input: {
  readonly auth?: SessionAuthContext | null;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payload: DeliverPayload;
  readonly sessionState: DurableSessionState;
}): Promise<RoutedDeliverResult> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const routed = routeDeliverPayload({
    payload: input.payload,
    state: durableSession.state,
  });

  for (const forChild of routed.forChildren) {
    await resumeHook(forChild.childContinuationToken, {
      auth: input.auth,
      kind: "deliver",
      payloads: [forChild.payload],
    });
  }

  return { remainder: routed.forSelf };
}

/** Starts a per-turn child workflow for the current driver session. */
export async function dispatchTurnStep(
  input: TurnWorkflowDispatchInput,
): Promise<{ readonly runId: string }> {
  "use step";

  const run = await startWorkflowPreferLatest(
    turnWorkflowReference,
    [createTurnWorkflowInput(input)],
    {
      allowReservedAttributes: true,
      attributes: normalizeEveAttributes(
        buildTurnAttributes({
          parentSessionId: input.sessionState.sessionId,
          requestId: input.delivery.kind === "deliver" ? input.delivery.requestId : undefined,
          rootSessionId: readRootSessionId(input.serializedContext) ?? input.sessionState.sessionId,
        }),
      ),
    },
  );

  return { runId: run.runId };
}
