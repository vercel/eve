import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { deriveSessionTitle } from "#execution/eve-workflow-attributes.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";
import { defaultDeliverResult } from "#channel/adapter.js";
import { contextStorage } from "#context/container.js";
import { runStep } from "#context/run-step.js";
import { refreshDynamicSessionSubagentsForRuntimeRevision } from "#context/dynamic-subagent-lifecycle.js";
import {
  rebindMissingCompiledDynamicToolCallbacks,
  refreshDynamicSessionToolsForRuntimeRevision,
} from "#context/dynamic-tool-lifecycle.js";
import {
  AuthKey,
  InitiatorAuthKey,
  SessionTitleKey,
  ParentSessionKey,
  CapabilitiesKey,
  ChannelDeliveryKey,
  HandleEventKey,
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicToolRuntimeRevisionKey,
  StaticModelReferenceKey,
  TurnDeliveryIdsKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { getHarnessEmissionState, isHarnessBetweenTurns } from "#harness/emission.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { RuntimeActionSettlementTimesKey } from "#harness/runtime-action-settlement-state.js";
import * as agentTraceState from "#tracing/agent-trace-context-store.js";
import {
  isTurnCancellation,
  SessionLimitDeclinedError,
  throwIfTurnAborted,
} from "#harness/turn-cancellation.js";
import { setChannelContext } from "#execution/channel-context.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { coalesceTurnInputs, validateHarnessModelMessages } from "#harness/messages.js";
import type { HandleEventFn, HarnessSession, StepInput, StepResult } from "#harness/types.js";
import type {
  DurableStepResult,
  TurnStepInput,
  TurnStepResult,
} from "#execution/session/turn-step-types.js";
import { resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import { withSessionStateDelta } from "#execution/session/state-delta.js";
import { openSessionEventPublisher } from "#execution/publish-session-events.js";
import { createTurnEventHandler } from "#execution/session/turn-event-handler.js";
import { derivePendingState } from "#execution/session/pending-turn-state.js";
import { createSessionStartedEvent, createTurnStartedEvent } from "#protocol/message.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { countRunUsage } from "#execution/agent-sessions/usage.js";
import {
  createDurableSessionValues,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { buildRuntimeIdentity, createExecutionNodeStep } from "#execution/node-step.js";
import { bindTurnCallerContext } from "#subagents/parent-notification.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession, refreshSessionFromTurnAgent } from "#execution/session.js";
import { createExecutionHistoryView } from "#execution/history-view.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { runModelCallBatch } from "#execution/model-call-batching.js";
import {
  createCancelledModelCallBatchResult,
  type CompletedModelCallCheckpoint,
} from "#execution/cancelled-model-call-batch.js";

function channelDeliveryErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "CHANNEL_DELIVERY_FAILED";
}

export type { TurnStepInput };

/** Runs a bounded batch of harness model steps inside one durable `"use step"` boundary. */
export async function turnStep(input: TurnStepInput): Promise<TurnStepResult> {
  "use step";
  return await withSessionStateDelta(input, (state) =>
    runSessionStep({
      ...state,
      serializedContext: bindTurnCallerContext(state.caller, state.serializedContext),
    }),
  );
}

async function runSessionStep(input: TurnStepInput): Promise<DurableStepResult> {
  const rawDelivery = input.input?.delivery;
  const delivery = rawDelivery;
  const runtimeResults = input.input?.runtimeResults;

  let durableSession = readDurableSession(input.sessionState);
  // An `execute` run's delegated spend counts in the step that hands the model its result.
  for (const usage of runtimeResults?.delegatedUsage ?? []) {
    durableSession = countRunUsage(durableSession, usage);
  }
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

  const previousAuth = ctx.get(AuthKey);

  // Apply deliver-time auth ferried via `resumeHook` (initial-turn
  // input has no auth; it was seeded by buildRunContext).
  if (delivery?.auth !== undefined) {
    ctx.set(AuthKey, delivery.auth ?? null);
    if (!ctx.has(InitiatorAuthKey)) ctx.set(InitiatorAuthKey, delivery.auth ?? null);
  }
  const initialSession: HarnessSession = {
    ...hydrateDurableSession({
      compactionOverrides: {
        thresholdPercent: effectiveAgent.thresholdPercent,
      },
      durable: durableSession,
      turnAgent: effectiveAgent.turnAgent,
    }),
    history: validateHarnessModelMessages(input.history),
  };
  const history = createExecutionHistoryView(initialSession);
  const instrumentation = bindSessionInstrumentation({
    agentName: effectiveAgent.turnAgent.id,
    ctx,
    rootSessionId: initialSession.rootSessionId ?? initialSession.sessionId,
    sessionId: initialSession.sessionId,
  });
  const initialEmissionState = getHarnessEmissionState(initialSession.state);
  if (
    !initialEmissionState.sessionStarted &&
    !ctx.has(SessionTitleKey) &&
    !ctx.has(ParentSessionKey)
  ) {
    const message = rawDelivery?.payloads.find((payload) => payload.message !== undefined)?.message;
    const title = deriveSessionTitle(rawDelivery?.title ?? message);
    if (title !== undefined) {
      ctx.set(SessionTitleKey, title);
      await setEveAttributes({ "$eve.title": title });
    }
  }

  if (rawDelivery !== undefined) {
    // Prepare only the session boundary here. Turn trace state is owned by the
    // tool loop: preparing it this early would persist stale principals and a
    // stale start time for deliveries that never start a turn (the park path).
    await contextStorage.run(ctx, () =>
      instrumentation?.preparePreamble({
        sequence: initialEmissionState.sequence,
        sessionStarted: initialEmissionState.sessionStarted,
      }),
    );
    await contextStorage.run(ctx, () =>
      instrumentation?.instrumentChannelDelivery({
        agentName: bundle.turnAgent.id,
        ctx,
        delivery: rawDelivery,
        rootSessionId: initialSession.rootSessionId ?? initialSession.sessionId,
        sequence: initialEmissionState.sequence,
        sessionId: initialSession.sessionId,
        turnId: activeTurnId(initialEmissionState),
      }),
    );
  }

  const failChannelDeliveries = async (error: unknown): Promise<void> => {
    await contextStorage.run(ctx, () =>
      instrumentation?.instrumentChannelDelivery({
        ctx,
        error,
        errorCode: channelDeliveryErrorCode(error),
        includeTurn: false,
        outcome: "failed",
      }),
    );
    await instrumentation?.flush();
  };
  const publisher = openSessionEventPublisher({
    ctx,
    origin: "own",
    sessionWritable: input.sessionWritable,
  });
  const { adapterCtx } = publisher.dispatcher;
  // A hook's `ctx.cancel()` aborts the same signal the harness already honors
  // for `session.cancel()`, so both settle through one cancellation path.
  const hookCancellation = new AbortController();
  const abortSignal =
    input.abortSignal === undefined
      ? hookCancellation.signal
      : AbortSignal.any([input.abortSignal, hookCancellation.signal]);
  try {
    const dynamicConnections = bindDynamicConnections(ctx, bundle.resolvedAgent);
    const effectiveNode = { ...bundle.graph.root, turnAgent: effectiveAgent.turnAgent };
    let compacted = false;
    const emitTurnEvent = createTurnEventHandler({
      abortSignal,
      bundle,
      canCancelTurn: input.input?.control === undefined,
      hookCancellation,
      ctx,
      dynamicConnections,
      effectiveAgent,
      effectiveNode,
      instrumentation,
      publisher,
    });
    const handleEvent: HandleEventFn = async (event, messages) => {
      if (event.type === "compaction.completed") compacted = true;
      await emitTurnEvent(event, messages);
    };
    const previousAdapterState =
      delivery !== undefined && !isHarnessBetweenTurns(initialSession)
        ? structuredClone(adapterCtx.state)
        : undefined;
    // Run the adapter's deliver hook for each queued payload and coalesce
    // the resulting StepInput values; runtime results ride the same input.
    let resolved: StepInput | undefined;
    if (delivery !== undefined) {
      const results: StepInput[] = [];
      try {
        for (const payload of delivery.payloads) {
          const result = adapter.deliver
            ? await adapter.deliver(payload, adapterCtx)
            : defaultDeliverResult(payload);

          if (result !== undefined && result !== null) {
            results.push(result);
          }
        }
      } catch (error) {
        await failChannelDeliveries(error);
        throw error;
      }
      resolved = results.length === 0 ? undefined : results.reduce(coalesceTurnInputs);
    }
    const ignoredActiveDelivery =
      delivery !== undefined && resolved === undefined && !isHarnessBetweenTurns(initialSession);
    if (ignoredActiveDelivery) {
      // The adapter sees the incoming caller, but an ignored correction must
      // not change the identity or reply destination of the interrupted work.
      if (previousAuth === undefined) ctx.delete(AuthKey);
      else ctx.set(AuthKey, previousAuth);
      adapterCtx.state = previousAdapterState!;
    } else {
      if (rawDelivery?.payloads.some((payload) => payload.message !== undefined)) {
        const ids = rawDelivery.deliveryMetadata?.map((entry) => entry.deliveryId) ?? [];
        ctx.set(
          TurnDeliveryIdsKey,
          initialEmissionState.turnId
            ? [...new Set([...(ctx.get(TurnDeliveryIdsKey) ?? []), ...ids])]
            : ids,
        );
      } else if (
        !initialEmissionState.sessionStarted &&
        ctx.get(ChannelDeliveryKey) !== undefined
      ) {
        ctx.set(TurnDeliveryIdsKey, [ctx.require(ChannelDeliveryKey).deliveryId]);
      }
    }

    if (runtimeResults !== undefined) {
      if (runtimeResults.acceptedAtMsByCallId !== undefined) {
        ctx.set(RuntimeActionSettlementTimesKey, runtimeResults.acceptedAtMsByCallId);
      }
      resolved = { ...resolved, runtimeActionResults: runtimeResults.results };
    }

    if (rawDelivery !== undefined) {
      const updatedAdapter = { ...adapter, state: { ...adapterCtx.state } };
      setChannelContext(ctx, updatedAdapter);
    }

    if (delivery !== undefined && resolved === undefined && isHarnessBetweenTurns(initialSession)) {
      await contextStorage.run(ctx, () =>
        instrumentation?.instrumentChannelDelivery({
          ctx,
          includeTurn: false,
          outcome: "completed",
        }),
      );
      await instrumentation?.flush();
      const aliased = reconcileSessionContinuationToken(ctx, initialSession);
      const nextSerializedContext = serializeContext(ctx);
      const nextValues =
        aliased === initialSession
          ? { history: input.history, sessionState: input.sessionState }
          : createDurableSessionValues(aliased);

      return {
        action: "park",
        ...derivePendingState(aliased),
        serializedContext: nextSerializedContext,
        ...nextValues,
      };
    }

    const dynamicSubagentResolvers = bundle.subagentRegistry.dynamicResolvers ?? [];
    const dynamicToolResolvers = bundle.resolvedAgent.dynamicToolResolvers ?? [];
    const runtimeIdentity = buildRuntimeIdentity(effectiveNode);
    try {
      const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
      const dynamicRuntimeRevision = deploymentId
        ? `deployment:${deploymentId}`
        : await resolveRuntimeCompiledArtifactsVersionedCacheKey(bundle.compiledArtifactsSource);
      const sessionStarted = initialEmissionState.sessionStarted;

      ctx.setVirtualContext(StaticModelReferenceKey, effectiveAgent.turnAgent.model ?? null);
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
            messages: history.initial.messages,
            runtimeRevision: dynamicRuntimeRevision,
          }),
          contextStorage.run(
            ctx,
            async () =>
              await refreshDynamicSessionToolsForRuntimeRevision({
                ctx,
                resolvers: dynamicToolResolvers,
                event: refreshEvent,
                messages: history.initial.messages,
                runtimeRevision: dynamicRuntimeRevision,
              }),
          ),
        ]);
        if (!isHarnessBetweenTurns(initialSession)) {
          await rebindMissingCompiledDynamicToolCallbacks({
            ctx,
            event: createTurnStartedEvent({
              sequence: initialEmissionState.sequence,
              turnId: activeTurnId(initialEmissionState),
            }),
            messages: history.initial.messages,
            resolvers: dynamicToolResolvers,
          });
        }
      }
    } catch (error) {
      await failChannelDeliveries(error);
      throw error;
    }

    const modelCallsPerStep =
      bundle.resolvedAgent.config?.experimental?.workflow?.modelCallsPerStep ?? 1;
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
      const modelSession = refreshedSession;

      const step = createExecutionNodeStep({
        steeringSignal: input.steeringSignal,
        abortSignal,
        capabilities,
        clearOnly: input.input?.control === "clear",
        compactOnly: input.input?.control === "compact",
        createRuntime: createWorkflowRuntime,
        handleEvent,
        prepareApprovalTurn: (event) => dynamicConnections.dispatch(createTurnStartedEvent(event)),
        historyProjector: history.projector,
        historyView: history.prepare(modelSession),
        instrumentation,
        modelResolutionScope: {
          moduleMap: bundle.moduleMap,
          nodeId: bundle.nodeId,
        },
        node: effectiveNode,
      });
      return step(modelSession, stepInput);
    };

    let completedModelCall: CompletedModelCallCheckpoint | undefined;
    let stepResult: StepResult;
    try {
      // A signal already aborted at entry (cancellation during an in-line
      // runtime-action wait) must settle before the park-resume stages run,
      // or the pending batch would re-park and later re-dispatch.
      throwIfTurnAborted(abortSignal);
      stepResult = await runModelCallBatch({
        steeringSignal: input.steeringSignal,
        initialInput: resolved,
        initialSession,
        modelCallsPerStep,
        runStep: async ({ firstCall, session, stepInput }) => {
          const result = await runStep(ctx, session, async (enrichedSession) => {
            ctx.setVirtualContext(HandleEventKey, handleEvent);
            ctx.setVirtualContext(StaticModelReferenceKey, effectiveAgent.turnAgent.model ?? null);
            let schemaSession =
              firstCall && resolved?.outputSchema !== undefined
                ? { ...enrichedSession, outputSchema: resolved.outputSchema }
                : enrichedSession;
            const connectionState = getHarnessEmissionState(schemaSession.state);
            await dynamicConnections.rehydrate(
              connectionState,
              runtimeIdentity,
              isHarnessBetweenTurns(schemaSession)
                ? undefined
                : { sequence: connectionState.sequence, turnId: activeTurnId(connectionState) },
            );
            return runHarnessStep(schemaSession, stepInput);
          });
          // The waiting boundary may reach the client before this step returns.
          // Its settled result wins over a cancellation of that completed turn.
          if (result.settledTurn === undefined) throwIfTurnAborted(abortSignal);
          completedModelCall = { result, serializedContext: serializeContext(ctx) };
          return result;
        },
      });
    } catch (error) {
      if (!isTurnCancellation(error) && !abortSignal.aborted) {
        await failChannelDeliveries(error);
        throw error;
      }
      return createCancelledModelCallBatchResult({
        beforeBatchContext: input.serializedContext,
        checkpoint: completedModelCall,
        ctx,
        // Stop already resolved the budget question, so the cancel must not withdraw it again.
        initialSession:
          error instanceof SessionLimitDeclinedError
            ? { ...initialSession, state: error.humanInput.write(initialSession.state) }
            : initialSession,
        stepInput: resolved,
      });
    }

    // Re-stamp the current address after handlers add a continuation alias.
    const aliased = reconcileSessionContinuationToken(ctx, stepResult.session);
    agentTraceState.pruneAgentTraceState(ctx, aliased.sessionId, aliased.state);
    const nextSerializedContext = serializeContext(ctx);
    stepResult = { ...stepResult, session: aliased };

    const durableResult = resolveSessionStepResult(stepResult, nextSerializedContext);
    if (durableResult.action === "done") await publisher.writer.close();
    return compacted ? { ...durableResult, compacted: true } : durableResult;
  } finally {
    publisher.writer.release();
  }
}
