import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { dispatchMemoryLifecycleEvent } from "#context/memory-event-lifecycle.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { deriveSessionTitle } from "#execution/eve-workflow-attributes.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";
import { defaultDeliverResult } from "#channel/adapter.js";
import { contextStorage, type ContextContainer } from "#context/container.js";
import {
  dispatchDynamicInstructionEvent,
  drainDynamicInstructionUserMessages,
  prepareDynamicInstructionPreamble,
} from "#context/dynamic-instruction-lifecycle.js";
import {
  dispatchDynamicSubagentEvent,
  refreshDynamicSessionSubagentsForRuntimeRevision,
} from "#context/dynamic-subagent-lifecycle.js";
import { drainMemoryCommit, prepareMemoryPreamble } from "#context/memory-lifecycle.js";
import {
  dispatchDynamicToolEvent,
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
  ModeKey,
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicToolRuntimeRevisionKey,
  StaticModelReferenceKey,
  TurnDeliveryIdsKey,
  TurnScheduleIdKey,
} from "#context/keys.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  emitTurnPreamble,
  getHarnessEmissionState,
  isHarnessBetweenTurns,
  setHarnessEmissionState,
} from "#harness/emission.js";
import {
  bindSessionInstrumentation,
  type ExecutionInstrumentation,
} from "#instrumentation/runtime.js";
import { RuntimeActionSettlementTimesKey } from "#harness/runtime-action-settlement-state.js";
import * as agentTraceState from "#tracing/agent-trace-context-store.js";
import { matchAuthorizationCallbacks } from "#execution/authorization-callback-match.js";
import { isTurnCancellation, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { setChannelContext } from "#execution/channel-context.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { runStep } from "#context/run-step.js";
import {
  coalesceTurnInputs,
  createTurnInputMessages,
  validateHarnessModelMessages,
  type UserModelMessage,
} from "#harness/messages.js";
import { consumeDeferredStepInput } from "#harness/pending-input-batches.js";
import type { HandleEventFn, HarnessSession, StepInput, StepResult } from "#harness/types.js";
import type { DurableStepResult, TurnStepInput } from "#execution/session/turn-step-types.js";
import { resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import { attributeAnswer, readDelegatedAnswerer } from "#execution/session/delegated-answer.js";
import { createSessionEventSink, type SessionEventSink } from "#execution/session/event-sink.js";
import { derivePendingState } from "#execution/session/pending-turn-state.js";
import {
  createAuthorizationCompletedEvent,
  createSessionStartedEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";
import {
  CallbackBaseUrlKey,
  clearPendingAuthorization,
  getPendingAuthorization,
  PendingAuthorizationResultKey,
} from "#harness/authorization.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { resolveEffectiveOutputSchema } from "#execution/effective-output-schema.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import {
  buildRuntimeIdentity,
  createExecutionNodeStep,
  createNodeHarnessTools,
} from "#execution/node-step.js";
import { takeTaskResultMessage } from "#harness/task-results.js";
import { prepareWorkflowPreambleTrace } from "#execution/workflow-trace-context.js";
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
import * as activityCohort from "#execution/activity-cohort.js";
import { hasDeliverableTaskResults, readTaskCreator } from "#tasks/results.js";

function channelDeliveryErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "CHANNEL_DELIVERY_FAILED";
}

export type { TurnStepInput };

/** Runs a bounded batch of harness model steps inside one durable `"use step"` boundary. */
export async function turnStep(rawInput: TurnStepInput): Promise<DurableStepResult> {
  "use step";
  return runSessionStep(rawInput);
}

async function runSessionStep(input: TurnStepInput): Promise<DurableStepResult> {
  // The delivery as accepted, before authorization callbacks are matched out of it.
  const rawDelivery = input.input?.delivery;
  let delivery = rawDelivery;
  const runtimeResults = input.input?.runtimeResults;

  let durableSession = readDurableSession(input.sessionState);
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

  const pendingAuth = getPendingAuthorization(durableSession.state);
  let completedAuths: ReturnType<typeof matchAuthorizationCallbacks>["matches"] | undefined;
  if (pendingAuth && delivery !== undefined) {
    const { matches, remainingPayloads } = matchAuthorizationCallbacks(
      pendingAuth,
      delivery.payloads,
    );
    delivery = { ...delivery, payloads: remainingPayloads };
    if (matches.length > 0) {
      const matchedAttemptIds = activityCohort.restoreAuthorizationActivity({
        ctx,
        matches,
        pending: pendingAuth,
      });
      const authResults = matches.map((match) => match.result);
      ctx.set(PendingAuthorizationResultKey, authResults);
      durableSession = {
        ...durableSession,
        state: clearPendingAuthorization(durableSession.state, matchedAttemptIds),
      };
      completedAuths = matches;
      if (remainingPayloads.length === 0) delivery = undefined;
    }
  }

  const previousAuth = ctx.get(AuthKey);

  const answerer = readDelegatedAnswerer(ctx, delivery);

  // Apply deliver-time auth ferried via `resumeHook` (initial-turn
  // input has no auth; it was seeded by buildRunContext). Only the turn's own
  // principal steers it (`isSteeringDelivery`), so a steering message never
  // changes who the turn acts for.
  if (delivery?.auth !== undefined && answerer === undefined) {
    ctx.set(AuthKey, delivery.auth ?? null);
    if (!ctx.has(InitiatorAuthKey)) ctx.set(InitiatorAuthKey, delivery.auth ?? null);
  }
  const initialSession = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: effectiveAgent.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const resultTurn = input.input?.taskResults;
  const resultCreator = resultTurn === undefined ? undefined : readTaskCreator(resultTurn.creator);
  if (resultCreator !== undefined) {
    // Nothing is left to deliver for this creator, so no turn starts.
    if (!hasDeliverableTaskResults(initialSession.state, resultCreator.auth)) {
      return {
        action: "park",
        ...derivePendingState(initialSession),
        serializedContext: input.serializedContext,
        sessionState: input.sessionState,
      };
    }
    // A result turn runs with the auth of the call that started its tasks,
    // and no channel delivery started it.
    ctx.set(AuthKey, resultCreator.auth);
    ctx.set(TurnDeliveryIdsKey, []);
  }
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
  const sink = createSessionEventSink({
    adapter,
    ctx,
    sessionWritable: input.sessionWritable,
    sessionId: initialSession.sessionId,
  });
  const { adapterCtx } = sink;
  try {
    const dynamicConnections = bindDynamicConnections(ctx, bundle.resolvedAgent);
    const effectiveNode = { ...bundle.graph.root, turnAgent: effectiveAgent.turnAgent };
    const handleEvent = createTurnEventHandler({
      abortSignal: input.abortSignal,
      bundle,
      ctx,
      dynamicConnections,
      effectiveAgent,
      effectiveNode,
      instrumentation,
      sink,
    });
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

          if (result !== undefined && result !== null) results.push(result);
        }
      } catch (error) {
        await failChannelDeliveries(error);
        throw error;
      }
      resolved = attributeAnswer(
        results.length === 0 ? undefined : results.reduce(coalesceTurnInputs),
        answerer,
      );
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
    if (!initialEmissionState.turnId) {
      if (rawDelivery?.scheduleId === undefined) ctx.delete(TurnScheduleIdKey);
      else ctx.set(TurnScheduleIdKey, rawDelivery.scheduleId);
    }

    if (runtimeResults !== undefined) {
      if (runtimeResults.acceptedAtMsByCallId !== undefined) {
        ctx.set(RuntimeActionSettlementTimesKey, runtimeResults.acceptedAtMsByCallId);
      }
      resolved = { ...resolved, runtimeActionResults: runtimeResults.results };
    }
    if (resultCreator !== undefined) {
      resolved = { ...resolved, taskResults: true };
      activityCohort.updateActivityRootForTaskResults({
        ctx,
        rootTurnId: resultCreator.activityRootTurnId,
      });
    }

    activityCohort.updateActivityRootForDelivery({
      activeTurnId: activeTurnId(initialEmissionState),
      ctx,
      delivery: ignoredActiveDelivery ? undefined : rawDelivery,
      sessionState: durableSession.state,
    });

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
      const nextState =
        aliased === initialSession
          ? input.sessionState
          : createDurableSessionState({ session: aliased });

      return {
        action: "park",
        ...derivePendingState(aliased),
        serializedContext: nextSerializedContext,
        sessionState: nextState,
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
    } catch (error) {
      await failChannelDeliveries(error);
      throw error;
    }

    const mode = ctx.require(ModeKey);
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
        abortSignal: input.abortSignal,
        capabilities,
        clearOnly: input.input?.control === "clear",
        compactOnly: input.input?.control === "compact",
        createRuntime: createWorkflowRuntime,
        handleEvent,
        historyProjector: history.projector,
        historyView: history.prepare(modelSession),
        instrumentation,
        mode,
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
      throwIfTurnAborted(input.abortSignal);
      stepResult = await runModelCallBatch({
        steeringSignal: input.steeringSignal,
        initialInput: resolved,
        initialSession,
        modelCallsPerStep,
        runStep: async ({ firstCall, session, stepInput }) => {
          const result = await runStep(ctx, session, async (enrichedSession) => {
            ctx.setVirtualContext(HandleEventKey, handleEvent);
            ctx.setVirtualContext(StaticModelReferenceKey, effectiveAgent.turnAgent.model ?? null);
            let schemaSession = firstCall
              ? resolveEffectiveOutputSchema({
                  agentOutputSchema: effectiveAgent.turnAgent.outputSchema,
                  input: resolved,
                  mode,
                  session: enrichedSession,
                })
              : enrichedSession;
            await dynamicConnections.rehydrate(
              getHarnessEmissionState(schemaSession.state),
              runtimeIdentity,
              isHarnessBetweenTurns(schemaSession),
            );
            if (firstCall && completedAuths) {
              let emissionState = getHarnessEmissionState(schemaSession.state);
              if (isHarnessBetweenTurns(schemaSession)) {
                const turnInput = createTurnInputMessages(
                  consumeDeferredStepInput({ session: schemaSession, input: stepInput }).input,
                );
                prepareDynamicInstructionPreamble(ctx, history.messages(schemaSession));
                prepareMemoryPreamble(ctx, {
                  history: schemaSession.history,
                  input: turnInput,
                  projector: history.projector,
                  state: schemaSession.state,
                });
                let instructionMessages: readonly UserModelMessage[] = [];
                const traceContext = await prepareWorkflowPreambleTrace({
                  emissionState,
                  instrumentation,
                });
                try {
                  emissionState = await emitTurnPreamble(
                    handleEvent,
                    {},
                    emissionState,
                    history.projector({
                      messages: [...schemaSession.history, ...turnInput],
                      state: schemaSession.state,
                    }),
                    runtimeIdentity,
                    traceContext,
                  );
                } finally {
                  instructionMessages = drainDynamicInstructionUserMessages(ctx);
                  const memoryCommit = drainMemoryCommit(ctx);
                  schemaSession = {
                    ...schemaSession,
                    history: validateHarnessModelMessages([
                      ...(memoryCommit?.history ?? schemaSession.history),
                      ...instructionMessages,
                    ]),
                    state: memoryCommit?.state ?? schemaSession.state,
                  };
                }
                schemaSession = setHarnessEmissionState(schemaSession, emissionState);
              }
              for (const { authorization, result } of completedAuths) {
                const candidateId = pendingAuth?.challenges.find(
                  (challenge) => challenge.attemptId === result.attemptId,
                )?.candidateId;
                await handleEvent(
                  createAuthorizationCompletedEvent({
                    attemptId: result.attemptId,
                    authorization,
                    candidateId,
                    name: result.name,
                    outcome: "authorized",
                    sequence: emissionState.sequence,
                    stepIndex: emissionState.stepIndex,
                    turnId: emissionState.turnId,
                  }),
                );
              }
            }

            return runHarnessStep(schemaSession, stepInput);
          });
          // The waiting boundary may reach the client before this step returns.
          // Its settled result wins over a cancellation of that completed turn.
          if (result.settledTurn === undefined) throwIfTurnAborted(input.abortSignal);
          completedModelCall = { result, serializedContext: serializeContext(ctx) };
          return result;
        },
      });
    } catch (error) {
      if (!isTurnCancellation(error) && input.abortSignal?.aborted !== true) {
        await failChannelDeliveries(error);
        throw error;
      }
      return createCancelledModelCallBatchResult({
        beforeBatchContext: input.serializedContext,
        checkpoint: completedModelCall,
        ctx,
        // Like a cancelled turn's user message, a cancelled result turn keeps
        // its results in history, so they do not start another result turn.
        initialSession:
          resultCreator === undefined || completedModelCall !== undefined
            ? initialSession
            : await keepTaskResults(initialSession, resultCreator.auth, effectiveNode),
        stepInput: resolved,
      });
    }

    // Re-stamp the current address after handlers add a continuation alias.
    const aliased = reconcileSessionContinuationToken(ctx, stepResult.session);
    agentTraceState.pruneAgentTraceState(ctx, aliased.sessionId, aliased.state);
    const nextSerializedContext = serializeContext(ctx);
    stepResult = { ...stepResult, session: aliased };

    const durableResult = resolveSessionStepResult(stepResult, nextSerializedContext, mode);
    if (durableResult.action === "done") await sink.close();
    return durableResult;
  } finally {
    sink.release();
  }
}

async function keepTaskResults(
  session: HarnessSession,
  principal: Parameters<typeof takeTaskResultMessage>[0]["principal"],
  node: CompiledBundle["graph"]["root"],
): Promise<HarnessSession> {
  const delivery = await takeTaskResultMessage({
    principal,
    session,
    tools: createNodeHarnessTools({ node }),
  });
  if (delivery === undefined) return session;
  return { ...delivery.session, history: [...delivery.session.history, delivery.message] };
}

/** Publishes one turn event, then runs memory, hooks, and model preparation for it. */
function createTurnEventHandler(input: {
  readonly abortSignal: AbortSignal | undefined;
  readonly bundle: CompiledBundle;
  readonly ctx: ContextContainer;
  readonly dynamicConnections: ReturnType<typeof bindDynamicConnections>;
  readonly effectiveAgent: ReturnType<typeof resolveEffectiveAgentRuntime>;
  readonly effectiveNode: CompiledBundle["graph"]["root"];
  readonly instrumentation: ExecutionInstrumentation | undefined;
  readonly sink: SessionEventSink;
}): HandleEventFn {
  const { abortSignal, bundle, ctx, effectiveAgent, effectiveNode } = input;
  return async (event, messages) => {
    const emitted = await input.sink.emit(event);
    const lifecycleMessages = await dispatchMemoryLifecycleEvent({
      abortSignal,
      appRoot: effectiveNode.agent?.metadata?.appRoot ?? "",
      ctx,
      event,
      instrumentation: input.instrumentation?.memory,
      memories: effectiveNode.agent?.memories ?? [],
      messages,
      nodeId: bundle.nodeId ?? "__root__",
    });
    if (!emitted.suppressed) {
      await dispatchStreamEventHooks({ ctx, registry: bundle.hookRegistry, event: emitted.event });
    }
    if (emitted.event.type !== "step.started") {
      await dispatchDynamicModelEvent({
        abortSignal,
        ctx,
        dynamicModel: effectiveAgent.turnAgent.dynamicModel,
        event: emitted.event,
        messages: lifecycleMessages,
        scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
      });
    }
    await input.dynamicConnections.dispatch(emitted.event);
    await dispatchDynamicSubagentEvent({
      ctx,
      resolvers: bundle.subagentRegistry.dynamicResolvers ?? [],
      event: emitted.event,
      messages: lifecycleMessages,
    });
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: bundle.resolvedAgent.dynamicToolResolvers ?? [],
      event: emitted.event,
      messages: lifecycleMessages,
    });
    await dispatchDynamicSkillEvent({
      ctx,
      resolvers: bundle.resolvedAgent.dynamicSkillResolvers ?? [],
      event: emitted.event,
      messages: lifecycleMessages,
    });
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: bundle.resolvedAgent.dynamicInstructionsResolvers ?? [],
      event: emitted.event,
      messages: lifecycleMessages,
    });
  };
}
