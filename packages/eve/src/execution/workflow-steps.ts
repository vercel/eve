import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, defaultDeliverResult } from "#channel/adapter.js";
import type {
  DeliverPayload,
  SessionAuthContext,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { AuthKey, CapabilitiesKey, ContinuationTokenKey, ModeKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { runStep, withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { setChannelContext } from "#execution/channel-context.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import { upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import {
  getRuntimeActionKeyFromInterrupt,
  isCodeModeRuntimeActionInterrupt,
} from "#harness/code-mode-runtime-action-state.js";
import { getPendingCodeModeInterrupt } from "#harness/code-mode-interrupt-state.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession, StepInput, StepResult } from "#harness/types.js";
import type { JsonObject } from "#shared/json.js";
import type { RunMode } from "#shared/run-mode.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";
import { createLogger, formatError } from "#internal/logging.js";
import {
  createAuthorizationCompletedEvent,
  createSessionFailedEvent,
  encodeMessageStreamEvent,
  type HandleMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import {
  CallbackBaseUrlKey,
  clearPendingAuthorization,
  getPendingAuthorization,
  PendingAuthorizationResultKey,
  type AuthorizationResult,
} from "#harness/authorization.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import type { AuthorizationCallback } from "#runtime/connections/types.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import {
  createTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowDispatchInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { createExecutionNodeStep } from "#execution/node-step.js";
import { emitProxiedInputRequest, routeDeliverPayload } from "#execution/subagent-hitl-proxy.js";
import { hydrateDurableSession, refreshSessionFromTurnAgent } from "#execution/session.js";
import { buildTurnAttributes, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";
import { turnWorkflow } from "#execution/turn-workflow.js";
import { createWorkflowRuntime, startWorkflowPreferLatest } from "#execution/workflow-runtime.js";

/**
 * Result of one durable harness step, consumed by the turn workflow.
 *
 * `park` carries `hasPendingInputBatch`, `hasPendingAuthorization`, and
 * `pendingRuntimeActionKeys` so the turn workflow can pick the right
 * {@link import("#execution/next-driver-action.js").NextDriverAction}
 * arm without re-reading the session.
 */
export type DurableStepResult =
  | {
      readonly action: "continue" | "done";
      readonly output?: unknown;
      readonly isError?: boolean;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly action: "park";
      readonly authorizationNames?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly pendingRuntimeActionKeys?: readonly string[];
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly action: "dispatch-code-mode-runtime-actions";
      readonly pendingRuntimeActionKeys: readonly string[];
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

export type { TurnStepInput };

/**
 * Runs one atomic harness step inside a durable `"use step"` boundary.
 */
export async function turnStep(rawInput: TurnStepInput): Promise<DurableStepResult> {
  "use step";

  let input = rawInput;

  // Tag this turn run with the lineage attributes the dashboard uses to
  // roll turns up under their parent session. Emitted from inside this
  // step — which the turn workflow already pays for — so we never spend
  // a standalone `__builtin_set_attributes` step in the workflow body.
  // The values are constant for the run, so emitting on every step
  // iteration is idempotent (last-write-wins) and avoids guessing which
  // iteration is "first". Best effort — `setEveAttributes` swallows
  // runtime failures.
  await setEveAttributes(
    buildTurnAttributes({
      parentSessionId: input.sessionState.sessionId,
      rootSessionId: readRootSessionId(input.serializedContext) ?? input.sessionState.sessionId,
    }),
  );

  let durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const bundle = ctx.require(BundleKey);

  // Populate the callback base URL so getHookUrl() works during
  // tool execution. Reads from workflow metadata (available in steps).
  try {
    const { getWorkflowMetadata } = await import("#compiled/@workflow/core/index.js");
    const metadata = getWorkflowMetadata();
    if (typeof metadata.url === "string") {
      ctx.set(CallbackBaseUrlKey, metadata.url.replace(/\/$/, ""));
    }
  } catch {
    // Outside a workflow context (e.g. tests) — getHookUrl will return undefined.
  }

  // Authorization callback. If the delivery carries an
  // `authorizationCallback` and there's a pending authorization on
  // session state, extract it, build AuthorizationResult entries, and
  // populate PendingAuthorizationResultKey so tools can complete auth.
  // Strip the callback from the delivery so the adapter doesn't see it.
  // Completion event names are collected here; emission happens after
  // the `emit` function is created below.
  const pendingAuth = getPendingAuthorization(durableSession.state);
  let completedAuths:
    | Array<{ name: string; authorization: ConnectionAuthorizationChallenge }>
    | undefined;
  if (pendingAuth && input.input?.kind === "deliver") {
    const authResults: Array<{ name: string } & AuthorizationResult> = [];
    const completed: Array<{ name: string; authorization: ConnectionAuthorizationChallenge }> = [];
    const remainingPayloads: DeliverPayload[] = [];
    for (const payload of input.input.payloads) {
      const cb = payload["authorizationCallback"] as
        | { connectionName: string; callback: AuthorizationCallback }
        | undefined;
      if (cb) {
        const challenge = pendingAuth.challenges.find((c) => c.name === cb.connectionName);
        if (challenge) {
          authResults.push({
            name: challenge.name,
            resume: challenge.resume,
            callback: cb.callback,
            hookUrl: challenge.hookUrl,
          });
          completed.push({ name: challenge.name, authorization: challenge.challenge });
        }
      } else {
        remainingPayloads.push(payload);
      }
    }
    if (authResults.length > 0) {
      ctx.set(PendingAuthorizationResultKey, authResults);
      durableSession = {
        ...durableSession,
        state: clearPendingAuthorization(
          durableSession.state,
          authResults.map((result) => result.name),
        ),
      };
      completedAuths = completed;
      input =
        remainingPayloads.length > 0
          ? { ...input, input: { ...input.input, payloads: remainingPayloads } }
          : { ...input, input: undefined };
    }
  }

  // Apply deliver-time auth ferried via `resumeHook` (initial-turn
  // input has no auth; it was seeded by buildRunContext).
  if (input.input?.kind === "deliver" && input.input.auth !== undefined) {
    ctx.set(AuthKey, input.input.auth ?? null);
  }

  const initialSession = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });

  const adapterCtx = buildAdapterContext(adapter, ctx);

  // Run the adapter's deliver hook for each queued payload and
  // coalesce the resulting StepInput values.
  let resolved: StepInput | undefined;
  if (input.input?.kind === "deliver") {
    const results: StepInput[] = [];
    for (const payload of input.input.payloads) {
      const result = adapter.deliver
        ? await adapter.deliver(payload, adapterCtx)
        : defaultDeliverResult(payload);

      if (result !== undefined && result !== null) {
        results.push(result);
      }
    }
    resolved = results.length === 0 ? undefined : results.reduce(coalesceTurnInputs);
  } else if (input.input?.kind === "runtime-action-result") {
    resolved = { runtimeActionResults: input.input.results };
  }

  // Pin adapter-state mutations back onto ctx so they survive the
  // step boundary.
  if (input.input?.kind === "deliver") {
    const updatedAdapter = { ...adapter, state: { ...adapterCtx.state } };
    setChannelContext(ctx, updatedAdapter);
  }

  // Adapter handled the delivery inline (e.g. a Slack interaction
  // that only edits a message). Re-park without a model turn; skip
  // the snapshot write when the session itself is unchanged.
  if (input.input?.kind === "deliver" && resolved === undefined) {
    const rekeyed = reconcileSessionContinuationToken(ctx, initialSession);
    const nextSerializedContext = serializeContext(ctx);
    const nextState =
      rekeyed === initialSession
        ? input.sessionState
        : createDurableSessionState({ session: rekeyed });

    return {
      action: "park",
      ...derivePendingState(rekeyed),
      serializedContext: nextSerializedContext,
      sessionState: nextState,
    };
  }

  const writer = input.parentWritable.getWriter();
  const hookRegistry = bundle.hookRegistry;
  const dynamicInstructionsResolvers = bundle.resolvedAgent.dynamicInstructionsResolvers ?? [];
  const dynamicSkillResolvers = bundle.resolvedAgent.dynamicSkillResolvers ?? [];
  const dynamicToolResolvers = bundle.resolvedAgent.dynamicToolResolvers ?? [];

  const emit = async (event: HandleMessageStreamEvent): Promise<HandleMessageStreamEvent> => {
    const toEmit = await callAdapterEventHandler(adapter, event, adapterCtx);
    setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
    await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(toEmit)));
    return toEmit;
  };

  const handleEvent = async (
    event: HandleMessageStreamEvent,
    messages?: readonly import("ai").ModelMessage[],
  ): Promise<void> => {
    const emitted = await emit(event);
    await dispatchStreamEventHooks({ ctx, registry: hookRegistry, event: emitted });
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: dynamicToolResolvers,
      event: emitted,
      messages: messages ?? [],
    });
    await dispatchDynamicSkillEvent({
      ctx,
      resolvers: dynamicSkillResolvers,
      event: emitted,
      messages: messages ?? [],
    });
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: dynamicInstructionsResolvers,
      event: emitted,
      messages: messages ?? [],
    });
  };

  const mode = ctx.require(ModeKey);

  let stepResult = await runStep(ctx, initialSession, async (enrichedSession) => {
    const schemaSession = resolveEffectiveOutputSchema({
      agentOutputSchema: bundle.turnAgent.outputSchema,
      input: resolved,
      mode,
      session: enrichedSession,
    });
    if (completedAuths) {
      const emissionState = getHarnessEmissionState(schemaSession.state);
      for (const { name, authorization } of completedAuths) {
        await handleEvent(
          createAuthorizationCompletedEvent({
            authorization,
            name,
            outcome: "authorized",
            sequence: emissionState.sequence,
            stepIndex: emissionState.stepIndex,
            turnId: emissionState.turnId,
          }),
        );
      }
    }

    const capabilities = ctx.get(CapabilitiesKey);

    const runHarnessStep = async (
      lifecycleSession: HarnessSession,
      stepInput: StepInput | undefined,
    ): Promise<StepResult> => {
      const refreshedSession = refreshSessionFromTurnAgent({
        compactionOverrides: {
          thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
        },
        session: lifecycleSession,
        turnAgent: bundle.turnAgent,
      });

      const step = createExecutionNodeStep({
        capabilities,
        createRuntime: createWorkflowRuntime,
        handleEvent,
        mode,
        modelResolutionScope: {
          moduleMap: bundle.moduleMap,
          nodeId: bundle.nodeId,
        },
        node: bundle.graph.root,
      });
      return step(refreshedSession, stepInput);
    };

    return runHarnessStep(schemaSession, resolved);
  });

  // Re-stamp the in-memory session's continuation token in case a
  // handler called `setContinuationToken(...)` (eg. Slack auto-anchor).
  const rekeyed = reconcileSessionContinuationToken(ctx, stepResult.session);
  const nextSerializedContext = serializeContext(ctx);
  stepResult = { ...stepResult, session: rekeyed };

  const nextState = createDurableSessionState({ session: stepResult.session });

  if (
    stepResult.next !== null &&
    typeof stepResult.next === "object" &&
    "done" in stepResult.next
  ) {
    await writer.close();
    return {
      action: "done",
      output: stepResult.next.output,
      isError: stepResult.next.isError,
      serializedContext: nextSerializedContext,
      sessionState: nextState,
    };
  }

  if (stepResult.next === null) {
    writer.releaseLock();

    const codeModeInterrupt = getPendingCodeModeInterrupt(stepResult.session.state);
    if (
      codeModeInterrupt !== undefined &&
      isCodeModeRuntimeActionInterrupt(codeModeInterrupt.interrupt)
    ) {
      return {
        action: "dispatch-code-mode-runtime-actions",
        pendingRuntimeActionKeys: [getRuntimeActionKeyFromInterrupt(codeModeInterrupt.interrupt)],
        serializedContext: nextSerializedContext,
        sessionState: nextState,
      };
    }

    return {
      action: "park",
      ...derivePendingState(stepResult.session),
      serializedContext: nextSerializedContext,
      sessionState: nextState,
    };
  }

  writer.releaseLock();
  return {
    action: "continue",
    serializedContext: nextSerializedContext,
    sessionState: nextState,
  };
}

/**
 * Derives the pending-state fields the turn workflow needs to choose
 * the right `NextDriverAction` arm at the park boundary.
 */
function derivePendingState(session: HarnessSession): {
  readonly authorizationNames?: readonly string[];
  readonly hasPendingAuthorization: boolean;
  readonly hasPendingInputBatch: boolean;
  readonly pendingRuntimeActionKeys?: readonly string[];
} {
  const batch = getPendingRuntimeActionBatch(session.state);
  const pendingAuth = getPendingAuthorization(session.state);
  const base = {
    authorizationNames: pendingAuth?.challenges.map((c) => c.name),
    hasPendingAuthorization: pendingAuth !== undefined,
    hasPendingInputBatch: hasPendingInputBatch(session.state),
  };
  if (batch !== undefined) {
    return {
      ...base,
      pendingRuntimeActionKeys: batch.actions.map((action) => getRuntimeActionRequestKey(action)),
    };
  }
  return base;
}

/**
 * Re-stamps `session.continuationToken` from `ContinuationTokenKey`
 * after channels call `setContinuationToken(...)`. Idempotent when the
 * token is unchanged.
 */
export function reconcileSessionContinuationToken(
  ctx: Awaited<ReturnType<typeof deserializeContext>>,
  session: HarnessSession,
): HarnessSession {
  const next = ctx.get(ContinuationTokenKey);
  if (next === undefined || next === session.continuationToken) return session;
  return { ...session, continuationToken: next };
}

/**
 * Resolves the single output schema in effect for this turn, decoupling schema
 * enforcement from {@link RunMode}: downstream the harness reads
 * `session.outputSchema` unconditionally and never re-derives it from mode.
 *
 * A run-scoped (client-supplied) schema on the turn's {@link StepInput} always
 * wins. With no run-scoped schema, a task run adopts the agent's declared
 * return schema — its function-output contract, which only applies when the
 * agent is invoked as a function (subagent / schedule / job), i.e. task mode.
 * A conversation run with no run-scoped schema enforces nothing. Continuation
 * steps (no new `StepInput`) preserve whatever is already in effect.
 */
export function resolveEffectiveOutputSchema(input: {
  readonly agentOutputSchema: JsonObject | undefined;
  readonly input: StepInput | undefined;
  readonly mode: RunMode;
  readonly session: HarnessSession;
}): HarnessSession {
  const { agentOutputSchema, input: stepInput, mode, session } = input;

  if (stepInput?.outputSchema !== undefined) {
    return { ...session, outputSchema: stepInput.outputSchema };
  }

  if (mode === "task" && session.outputSchema === undefined && agentOutputSchema !== undefined) {
    return { ...session, outputSchema: agentOutputSchema };
  }

  return session;
}

const log = createLogger("execution.workflow-entry");

/** Emits a terminal `session.failed` to the adapter and durable stream. */
export async function emitTerminalSessionFailureStep(input: {
  readonly error: unknown;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";

  const details = formatError(input.error);
  const code = typeof details.name === "string" ? details.name : "WORKFLOW_EXECUTION_FAILED";
  const message = typeof details.message === "string" ? details.message : String(input.error);
  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";

  log.error("workflow loop threw — emitting terminal session.failed", {
    sessionId,
    errorId: typeof details.errorId === "string" ? details.errorId : undefined,
    code,
    message,
    detail: typeof details.detail === "string" ? details.detail : undefined,
  });

  const event = createSessionFailedEvent({ code, details, message, sessionId });

  // Best-effort: invoke the adapter handler so channels surface the
  // failure. Errors are logged, never rethrown — the outer workflow
  // throw must still reach the run handle.
  try {
    const ctx = await deserializeContext(input.serializedContext);
    const adapter = ctx.get(ChannelKey);
    if (adapter !== undefined) {
      const adapterCtx = buildAdapterContext(adapter, ctx);
      await callAdapterEventHandler(adapter, event, adapterCtx);
    }
  } catch (notificationError) {
    log.error("adapter failed to handle terminal session.failed event", {
      errorId: typeof details.errorId === "string" ? details.errorId : undefined,
      sessionId,
      error: notificationError,
    });
  }

  // Always write the event to the durable stream so downstream
  // consumers see a canonical terminal event instead of an abrupt
  // stream close.
  try {
    const writer = input.parentWritable.getWriter();
    try {
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(event)));
    } finally {
      writer.releaseLock();
    }
  } catch (writeError) {
    log.error("failed to write terminal session.failed event to durable stream", {
      errorId: typeof details.errorId === "string" ? details.errorId : undefined,
      sessionId,
      error: writeError,
    });
  }
}

export interface ProxyInputRequestResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Emits a proxied `input.requested` event through the parent's adapter
 * and records the routing entries on the parent session.
 */
export async function runProxyInputRequestStep(input: {
  readonly hookPayload: SubagentInputRequestHookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<ProxyInputRequestResult> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const mode = ctx.require(ModeKey);
  const bundle = ctx.require(BundleKey);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });
  const writer = input.parentWritable.getWriter();

  let scopeResult: {
    readonly result: readonly (readonly [requestId: string, childContinuationToken: string])[];
    readonly session: HarnessSession;
  };
  try {
    const emit = async (event: HandleMessageStreamEvent): Promise<void> => {
      const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(transformed)));
    };

    scopeResult = await withContextScope(ctx, session, async (enrichedSession) => {
      const proxyResult = await emitProxiedInputRequest({
        emit,
        hookPayload: input.hookPayload,
        mode,
        session: enrichedSession,
      });
      return { result: proxyResult.entries, session: proxyResult.session };
    });
  } finally {
    writer.releaseLock();
  }

  // Persist adapter-state mutations (e.g. Slack's `pendingRequests`
  // cache populated by the `input.requested` handler) so the next
  // `turnStep` observes them across the serialized context
  // boundary. Without this the workflow runtime rehydrates a stale
  // adapter and later text-reply deliveries miss the cached batch.
  setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });

  const nextSerializedContext = serializeContext(ctx);

  const sessionWithProxyEntries = upsertProxyInputRequests({
    entries: scopeResult.result,
    forChildContinuationToken: input.hookPayload.childContinuationToken,
    session: scopeResult.session,
  });
  const nextSession = reconcileSessionContinuationToken(ctx, sessionWithProxyEntries);
  const nextState = createDurableSessionState({ session: nextSession });

  return {
    serializedContext: nextSerializedContext,
    sessionState: nextState,
  };
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

  const { resumeHook } = await import("#compiled/@workflow/core/runtime.js");
  process.env.WORKFLOW_QUEUE_NAMESPACE = "eve";

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

  const run = await startWorkflowPreferLatest(turnWorkflow, [createTurnWorkflowInput(input)]);

  return { runId: run.runId };
}
