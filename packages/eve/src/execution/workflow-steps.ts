import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, defaultDeliverResult } from "#channel/adapter.js";
import { type AttributedDeliverPayload } from "#channel/types.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import {
  dispatchDynamicSubagentEvent,
  refreshDynamicSessionSubagentsForRuntimeRevision,
} from "#context/dynamic-subagent-lifecycle.js";
import {
  dispatchDynamicToolEvent,
  refreshDynamicSessionToolsForRuntimeRevision,
} from "#context/dynamic-tool-lifecycle.js";
import {
  AuthKey,
  CapabilitiesKey,
  ModeKey,
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicToolRuntimeRevisionKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { runStep } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { preserveSerializedAgentTraceState } from "#tracing/agent-trace-context-store.js";
import { readTurnSleepDurationMs } from "#harness/turn-sleep.js";
import { isTurnCancellation, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { setChannelContext } from "#execution/channel-context.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import {
  getRuntimeActionKeysFromWorkflowInterrupt,
  isWorkflowRuntimeActionInterrupt,
} from "#harness/workflow-runtime-action-state.js";
import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession, StepInput, StepResult } from "#harness/types.js";
import { getTurnUsageState, toUsage } from "#harness/turn-tag-state.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { JsonObject } from "#shared/json.js";
import type { RunMode } from "#shared/run-mode.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";
import {
  createAuthorizationCompletedEvent,
  createSessionStartedEvent,
  encodeMessageStreamEvent,
  type UnstampedMessageStreamEvent,
  stampMessageStreamEvent,
  type MessageStreamEvent,
} from "#protocol/message.js";
import { getApprovalAuditState } from "#harness/approval-candidates.js";
import {
  CallbackBaseUrlKey,
  clearPendingAuthorization,
  getPendingAuthorization,
  PendingAuthorizationResultKey,
  type AuthorizationResult,
} from "#harness/authorization.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
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
import { buildRuntimeIdentity, createExecutionNodeStep } from "#execution/node-step.js";
import { routeDeliverPayload } from "#execution/subagent-hitl-proxy.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { recordSubagentUsageSpans } from "#execution/subagent-usage-span.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession, refreshSessionFromTurnAgent } from "#execution/session.js";
import { buildTurnAttributes, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import {
  createWorkflowRuntime,
  startWorkflowPreferLatest,
  turnWorkflowReference,
} from "#execution/workflow-runtime.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/**
 * Result of one durable harness step, consumed by the turn workflow.
 *
 * `park` carries `hasPendingInputBatch`, `hasPendingAuthorization`, and
 * `pendingRuntimeActionKeys` so the turn workflow can pick the right
 * {@link import("#execution/next-driver-action.js").NextDriverAction}
 * arm without re-reading the session.
 *
 * `cancelled` converts the harness's cancellation throw into a *returned*
 * result so workflow-core never classifies the abort as a step failure or
 * retries it; the epilogue runs in `settleCancelledTurnStep`.
 */
export type DurableStepResult =
  | {
      readonly action: "continue" | "done";
      readonly output?: unknown;
      readonly isError?: boolean;
      /**
       * Optional durable pause for the turn workflow to fulfill before
       * dispatching this result's next action.
       */
      readonly sleepDurationMs?: number;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
      /** Session-total token usage; set on `done` when the session spent any. */
      readonly usage?: TokenUsage;
    }
  | {
      readonly action: "cancelled";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly action: "park";
      readonly approvalCandidateExpiresAt?: number;
      readonly authorizationNames?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly pendingRuntimeActionKeys?: readonly string[];
      readonly sleepDurationMs?: number;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly action: "dispatch-workflow-runtime-actions";
      readonly pendingRuntimeActionKeys: readonly string[];
      readonly sleepDurationMs?: number;
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

  let durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);

  // Populate the callback base URL so getHookUrl() works during tool
  // execution, preferring eve's active local origin over metadata fallback.
  try {
    const { getWorkflowMetadata } = await import("#compiled/@workflow/core/index.js");
    const metadata = getWorkflowMetadata();
    if (typeof metadata.url === "string") {
      ctx.set(CallbackBaseUrlKey, resolveWorkflowCallbackBaseUrl(metadata.url));
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
    const remainingPayloads: AttributedDeliverPayload[] = [];
    for (const attributed of input.input.payloads) {
      const { payload } = attributed;
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
        remainingPayloads.push(attributed);
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

  const initialSession = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: effectiveAgent.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });

  const adapterCtx = buildAdapterContext(adapter, ctx);

  // Run the adapter's deliver hook for each queued payload and
  // coalesce the resulting StepInput values.
  let resolved: StepInput | undefined;
  if (input.input?.kind === "deliver") {
    const results: StepInput[] = [];
    for (const attributed of input.input.payloads) {
      const { auth, payload } = attributed;
      ctx.set(AuthKey, auth ?? null);
      const result = adapter.deliver
        ? await adapter.deliver(payload, adapterCtx)
        : defaultDeliverResult(payload);

      if (result !== undefined && result !== null) {
        results.push({
          ...result,
          attributedInputResponses: result.inputResponses?.map((response) => ({
            auth: auth ?? null,
            response,
          })),
          inputResponses: undefined,
          messageAuth: result.message === undefined ? undefined : auth,
        });
      }
    }
    resolved = results.length === 0 ? undefined : results.reduce(coalesceTurnInputs);
  } else if (input.input?.kind === "runtime-action-result") {
    recordSubagentUsageSpans(input.input.results);
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

  const hookRegistry = bundle.hookRegistry;
  const dynamicInstructionsResolvers = bundle.resolvedAgent.dynamicInstructionsResolvers ?? [];
  const dynamicSkillResolvers = bundle.resolvedAgent.dynamicSkillResolvers ?? [];
  const dynamicSubagentResolvers = bundle.subagentRegistry.dynamicResolvers ?? [];
  const dynamicToolResolvers = bundle.resolvedAgent.dynamicToolResolvers ?? [];
  const effectiveNode = {
    ...bundle.graph.root,
    turnAgent: effectiveAgent.turnAgent,
  };
  const runtimeIdentity = buildRuntimeIdentity(effectiveNode);
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  const dynamicRuntimeRevision = deploymentId
    ? `deployment:${deploymentId}`
    : await resolveRuntimeCompiledArtifactsVersionedCacheKey(bundle.compiledArtifactsSource);
  const sessionStarted = getHarnessEmissionState(initialSession.state).sessionStarted;

  if (!sessionStarted) {
    ctx.set(SessionDynamicSubagentRuntimeRevisionKey, dynamicRuntimeRevision);
    ctx.set(SessionDynamicToolRuntimeRevisionKey, dynamicRuntimeRevision);
  } else {
    const refreshEvent = createSessionStartedEvent({ runtime: runtimeIdentity });
    await Promise.all([
      refreshDynamicSessionSubagentsForRuntimeRevision({
        ctx,
        resolvers: dynamicSubagentResolvers,
        event: refreshEvent,
        messages: initialSession.history,
        runtimeRevision: dynamicRuntimeRevision,
      }),
      refreshDynamicSessionToolsForRuntimeRevision({
        ctx,
        resolvers: dynamicToolResolvers,
        event: refreshEvent,
        messages: initialSession.history,
        runtimeRevision: dynamicRuntimeRevision,
      }),
    ]);
  }

  const writer = input.parentWritable.getWriter();

  // Stamp once: the persisted chunk and the hooks below must agree on the id.
  const emit = async (event: UnstampedMessageStreamEvent): Promise<MessageStreamEvent> => {
    const toEmit = await callAdapterEventHandler(adapter, event, adapterCtx);
    setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
    const stamped = stampMessageStreamEvent(toEmit);
    await writer.write(encodeMessageStreamEvent(stamped));
    return stamped;
  };

  const handleEvent = async (
    event: UnstampedMessageStreamEvent,
    messages?: readonly import("ai").ModelMessage[],
  ): Promise<void> => {
    const emitted = await emit(event);
    await dispatchStreamEventHooks({ ctx, registry: hookRegistry, event: emitted });
    if (emitted.type !== "step.started") {
      await dispatchDynamicModelEvent({
        ctx,
        dynamicModel: effectiveAgent.turnAgent.dynamicModel,
        event: emitted,
        fallback: effectiveAgent.turnAgent.model,
        messages: messages ?? [],
        scope: {
          moduleMap: bundle.moduleMap,
          nodeId: bundle.nodeId,
        },
      });
    }
    await dispatchDynamicSubagentEvent({
      ctx,
      resolvers: dynamicSubagentResolvers,
      event: emitted,
      messages: messages ?? [],
    });
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

  let stepResult: StepResult;
  try {
    // A signal already aborted at entry (cancellation during an in-line
    // runtime-action wait) must settle before the park-resume stages run,
    // or the pending batch would re-park and later re-dispatch.
    throwIfTurnAborted(input.abortSignal);
    stepResult = await runStep(ctx, initialSession, async (enrichedSession) => {
      const schemaSession = resolveEffectiveOutputSchema({
        agentOutputSchema: effectiveAgent.turnAgent.outputSchema,
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
            thresholdPercent: effectiveAgent.thresholdPercent,
          },
          session: lifecycleSession,
          turnAgent: effectiveAgent.turnAgent,
        });

        const step = createExecutionNodeStep({
          abortSignal: input.abortSignal,
          capabilities,
          clearOnly: input.input?.kind === "clear",
          compactOnly: input.input?.kind === "compact",
          createRuntime: createWorkflowRuntime,
          handleEvent,
          mode,
          modelResolutionScope: {
            moduleMap: bundle.moduleMap,
            nodeId: bundle.nodeId,
          },
          node: effectiveNode,
          workflowMaxSubagents: refreshedSession.workflowMaxSubagents,
        });
        return step(refreshedSession, stepInput);
      };

      return runHarnessStep(schemaSession, resolved);
    });
  } catch (error) {
    if (!isTurnCancellation(error)) throw error;
    writer.releaseLock();
    return {
      action: "cancelled",
      serializedContext: preserveSerializedAgentTraceState(
        input.serializedContext,
        serializeContext(ctx),
      ),
      sessionState: input.sessionState,
    };
  }

  // Re-stamp the in-memory session's continuation token in case a
  // handler called `setContinuationToken(...)` (eg. Slack auto-anchor).
  const rekeyed = reconcileSessionContinuationToken(ctx, stepResult.session);
  const nextSerializedContext = serializeContext(ctx);
  stepResult = { ...stepResult, session: rekeyed };

  const nextState = createDurableSessionState({ session: stepResult.session });
  const sleepDurationMs = readTurnSleepDurationMs(ctx);
  const sleepTransition = sleepDurationMs === undefined ? {} : { sleepDurationMs };

  if (
    stepResult.next !== null &&
    typeof stepResult.next === "object" &&
    "done" in stepResult.next
  ) {
    await writer.close();
    const sessionTotals = getTurnUsageState(stepResult.session.state)?.session;
    return {
      action: "done",
      output: stepResult.next.output,
      isError: stepResult.next.isError,
      ...sleepTransition,
      serializedContext: nextSerializedContext,
      sessionState: nextState,
      usage: sessionTotals === undefined ? undefined : toUsage(sessionTotals),
    };
  }

  if (stepResult.next === null) {
    writer.releaseLock();

    const workflowInterrupt = getPendingWorkflowInterrupt(stepResult.session.state);
    if (
      workflowInterrupt !== undefined &&
      isWorkflowRuntimeActionInterrupt(workflowInterrupt.interrupt)
    ) {
      return {
        action: "dispatch-workflow-runtime-actions",
        pendingRuntimeActionKeys: getRuntimeActionKeysFromWorkflowInterrupt(
          workflowInterrupt.interrupt,
        ),
        ...sleepTransition,
        serializedContext: nextSerializedContext,
        sessionState: nextState,
      };
    }

    return {
      action: "park",
      ...derivePendingState(stepResult.session),
      ...sleepTransition,
      serializedContext: nextSerializedContext,
      sessionState: nextState,
    };
  }

  writer.releaseLock();
  return {
    action: "continue",
    ...sleepTransition,
    serializedContext: nextSerializedContext,
    sessionState: nextState,
  };
}

/**
 * Derives the pending-state fields the turn workflow needs to choose
 * the right `NextDriverAction` arm at the park boundary.
 */
function derivePendingState(session: HarnessSession): {
  readonly approvalCandidateExpiresAt?: number;
  readonly authorizationNames?: readonly string[];
  readonly hasPendingAuthorization: boolean;
  readonly hasPendingInputBatch: boolean;
  readonly pendingRuntimeActionKeys?: readonly string[];
} {
  const batch = getPendingRuntimeActionBatch(session.state);
  const pendingAuth = getPendingAuthorization(session.state);
  const candidateDeadlines = getApprovalAuditState(session.state).activeCandidates.map(
    (candidate) => candidate.expiresAt,
  );
  const base = {
    approvalCandidateExpiresAt:
      candidateDeadlines.length === 0 ? undefined : Math.min(...candidateDeadlines),
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

export type RoutedDeliverResult =
  | { readonly kind: "cancel-turn" }
  | {
      readonly kind: "continue";
      /** `undefined` when every payload was routed to descendants. */
      readonly remainder: readonly AttributedDeliverPayload[] | undefined;
    };

/**
 * Splits an inbound deliver payload into parent-local and
 * proxied-child buckets and forwards the child buckets via
 * `resumeHook`. Read-only: never appends a snapshot.
 */
export async function routeProxiedDeliverStep(input: {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payloads: readonly AttributedDeliverPayload[];
  readonly sessionState: DurableSessionState;
}): Promise<RoutedDeliverResult> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const forChildren = new Map<string, AttributedDeliverPayload[]>();
  const remainder: AttributedDeliverPayload[] = [];
  let cancelTurn = false;

  for (const attributed of input.payloads) {
    const { auth, payload } = attributed;
    const routed = routeDeliverPayload({ payload, state: durableSession.state });
    cancelTurn ||= routed.parentAction?.kind === "cancel-turn";

    for (const child of routed.forChildren) {
      const payloads = forChildren.get(child.childContinuationToken) ?? [];
      payloads.push({ auth, payload: child.payload });
      forChildren.set(child.childContinuationToken, payloads);
    }
    if (routed.forSelf !== undefined) {
      remainder.push({ auth, payload: routed.forSelf });
    }
  }

  for (const [childContinuationToken, payloads] of forChildren) {
    await resumeHook(childContinuationToken, { kind: "deliver", payloads });
  }

  return cancelTurn
    ? { kind: "cancel-turn" }
    : { kind: "continue", remainder: remainder.length === 0 ? undefined : remainder };
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
