import { bindTurnCallerContext } from "#subagents/parent-notification.js";
import type { HandleEventFn } from "#harness/types.js";
import { bindSessionParticipants } from "#execution/participants.js";
import { recoverDynamicConnectionRehydration } from "#execution/dynamic-connection-recovery.js";
import { deriveSessionTitle } from "#execution/eve-workflow-attributes.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";
import { defaultDeliverResult } from "#channel/adapter.js";
import { contextStorage } from "#context/container.js";
import { runStep } from "#context/run-step.js";
import {
  AuthKey,
  ScheduleIdKey,
  ScheduleInstanceKey,
  OccurrenceIdKey,
  InitiatorAuthKey,
  SessionTitleKey,
  ParentSessionKey,
  CapabilitiesKey,
  ChannelDeliveryKey,
  HandleEventKey,
  StaticModelReferenceKey,
  TurnDeliveryIdsKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { RuntimeActionSettlementTimesKey } from "#harness/runtime-action-settlement-state.js";
import * as agentTraceState from "#tracing/agent-trace-context-store.js";
import { matchAuthorizationCallbacks } from "#execution/authorization-callback-match.js";
import { isTurnCancellation, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  activeTurnId,
  isBetweenTurns,
  storedProjection,
  turnPosition,
} from "#harness/session-machine/view.js";
import {
  currentProjection,
  enterSessionProjection,
  saveSessionProjection,
} from "#harness/session-machine/current.js";
import { saveTransition, dropClosedRecords, sessionView } from "#harness/session-machine/commit.js";
import { matchSignIns } from "#harness/session-machine/transitions.js";
import { coalesceTurnInputs, validateHarnessModelMessages } from "#harness/messages.js";
import type { HarnessSession, StepInput, StepResult } from "#harness/types.js";
import { attributeAnswers } from "#execution/session/answer-caller.js";
import type {
  DurableStepResult,
  TurnStepInput,
  TurnStepResult,
} from "#execution/session/turn-step-types.js";
import { pausedOrParked, resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import { withSessionStateDelta } from "#execution/session/state-delta.js";
import { openSessionEventPublisher } from "#execution/publish-session-events.js";
import { eventsOf } from "#harness/publication.js";
import { createTurnEventHandler } from "#execution/session/turn-event-handler.js";
import { CallbackBaseUrlKey, PendingAuthorizationResultKey } from "#harness/authorization.js";
import { readHitlState } from "#harness/hitl/index.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { countRunUsage } from "#execution/agent-sessions/usage.js";
import {
  createDurableSessionValues,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { buildRuntimeIdentity, createExecutionNodeStep } from "#execution/node-step.js";
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
import type { AuthorizationChallenge } from "#harness/authorization.js";

function channelDeliveryErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "CHANNEL_DELIVERY_FAILED";
}

export type { TurnStepInput };

interface PendingStepAttributes {
  title?: Promise<void>;
}

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
  const pendingAttributes: PendingStepAttributes = {};
  try {
    return await runSessionStepBody(input, pendingAttributes);
  } finally {
    await pendingAttributes.title;
  }
}

async function runSessionStepBody(
  input: TurnStepInput,
  pendingAttributes: PendingStepAttributes,
): Promise<DurableStepResult> {
  // The delivery as accepted, before authorization callbacks are matched out of it.
  const rawDelivery = input.input?.delivery;
  let delivery = rawDelivery;
  const runtimeResults = input.input?.runtimeResults;

  let durableSession = readDurableSession(input.sessionState);
  // An `execute` run's delegated spend counts in the step that hands the model its result.
  for (const usage of runtimeResults?.delegatedUsage ?? []) {
    durableSession = countRunUsage(durableSession, usage);
  }
  const ctx = await deserializeContext(input.serializedContext);
  enterSessionProjection(ctx, durableSession.state);
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

  const { signIns } = readHitlState(durableSession.state);
  let completedAuths: ReturnType<typeof matchAuthorizationCallbacks>["matches"] | undefined;
  if (signIns.length > 0 && delivery !== undefined) {
    const { matches, remainingPayloads } = matchAuthorizationCallbacks(signIns, delivery.payloads);
    delivery = { ...delivery, payloads: remainingPayloads };
    if (matches.length > 0) {
      const matchedAttemptIds = matches.map((match) => match.result.attemptId);
      const authResults = matches.map((match) => match.result);
      ctx.set(PendingAuthorizationResultKey, authResults);
      // The session stops waiting on them; the turn they resume reports their completion.
      const view = sessionView(storedProjection(durableSession.state), durableSession.state);
      const transition = matchSignIns(view, { attemptIds: matchedAttemptIds });
      if (transition.events.length !== 0) throw new Error("matchSignIns must not emit events.");
      durableSession = saveTransition(durableSession, transition);
      completedAuths = matches;
      if (remainingPayloads.length === 0) delivery = undefined;
    }
  }

  // A new inbound message is a new caller action, not a scheduled occurrence.
  // Approval/input responses alone keep the parked turn's provenance.
  if (delivery?.payloads.some((payload) => payload.message !== undefined)) {
    ctx.delete(ScheduleIdKey);
    ctx.delete(ScheduleInstanceKey);
    ctx.delete(OccurrenceIdKey);
    if (delivery.schedule !== undefined) {
      ctx.set(ScheduleIdKey, delivery.schedule.definition);
      if (delivery.schedule.instance !== undefined)
        ctx.set(ScheduleInstanceKey, delivery.schedule.instance);
      if (delivery.schedule.occurrenceId !== undefined)
        ctx.set(OccurrenceIdKey, delivery.schedule.occurrenceId);
    }
  }
  const previousAuth = ctx.get(AuthKey);
  const hadInitiator = ctx.has(InitiatorAuthKey);

  // Apply deliver-time auth ferried via `resumeHook` (initial-turn
  // input has no auth; it was seeded by buildRunContext).
  if (delivery?.auth !== undefined) {
    ctx.set(AuthKey, delivery.auth ?? null);
    if (!ctx.has(InitiatorAuthKey)) ctx.set(InitiatorAuthKey, delivery.auth ?? null);
  }
  // A sign-in callback carries no identity. Resume as the user who started the
  // sign-in, not whoever spoke in the session while it was pending. Approval
  // sign-ins (`candidateId`) bind their responder separately.
  const requester =
    delivery === undefined
      ? completedAuths?.find(({ challenge }) => challenge.candidateId === undefined)?.challenge
          .requester
      : undefined;
  if (requester !== undefined) ctx.set(AuthKey, requester);
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
  const initialEmissionState = turnPosition(currentProjection(ctx));
  const startedBetweenTurns = isBetweenTurns(currentProjection(ctx));
  if (
    !initialEmissionState.sessionStarted &&
    !ctx.has(SessionTitleKey) &&
    !ctx.has(ParentSessionKey)
  ) {
    const message = rawDelivery?.payloads.find((payload) => payload.message !== undefined)?.message;
    const title = deriveSessionTitle(rawDelivery?.title ?? message);
    if (title !== undefined) {
      ctx.set(SessionTitleKey, title);
      pendingAttributes.title = setEveAttributes({ "$eve.title": title });
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
    const effectiveNode = { ...bundle.graph.root, turnAgent: effectiveAgent.turnAgent };
    const participants = bindSessionParticipants({
      abortSignal,
      bundle,
      ctx,
      effectiveAgent,
      effectiveNode,
      instrumentation,
    });
    let compacted = false;
    const emitTurnEvent = createTurnEventHandler({
      canCancelTurn: input.input?.control === undefined,
      hookCancellation,
      participants,
      publisher,
    });
    const handleEvent: HandleEventFn = async (publication, messages) => {
      if (eventsOf(publication).some((event) => event.type === "compaction.completed")) {
        compacted = true;
      }
      await emitTurnEvent(publication, messages);
    };
    const previousAdapterState =
      delivery !== undefined && !startedBetweenTurns
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
    // A delivery without auth acts as the session's current identity, so
    // only a delivery that names its sender can be answered by someone else.
    const answers =
      delivery?.auth === undefined
        ? undefined
        : attributeAnswers({
            responder: delivery.auth,
            state: durableSession.state,
            stepInput: resolved,
          });
    if (answers !== undefined) {
      // The responder settles the request; the turn keeps its caller and
      // initiator. Adapter state from the answer stays: channels record the
      // responder and their prompt cards there, not the reply destination.
      resolved = answers;
      if (previousAuth === undefined) ctx.delete(AuthKey);
      else ctx.set(AuthKey, previousAuth);
      if (!hadInitiator) ctx.delete(InitiatorAuthKey);
    }
    const ignoredActiveDelivery =
      delivery !== undefined && resolved === undefined && !startedBetweenTurns;
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

    if (delivery !== undefined && resolved === undefined && startedBetweenTurns) {
      await contextStorage.run(ctx, () =>
        instrumentation?.instrumentChannelDelivery({
          ctx,
          includeTurn: false,
          outcome: "completed",
        }),
      );
      await instrumentation?.flush();
      const aliased = saveSessionProjection(
        reconcileSessionContinuationToken(ctx, initialSession),
        ctx,
      );
      const nextSerializedContext = serializeContext(ctx);
      const nextValues =
        aliased === initialSession
          ? { history: input.history, sessionState: input.sessionState }
          : createDurableSessionValues(aliased);

      return pausedOrParked(aliased, {
        serializedContext: nextSerializedContext,
        ...nextValues,
      });
    }

    const runtimeIdentity = buildRuntimeIdentity(effectiveNode);
    try {
      const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
      ctx.setVirtualContext(StaticModelReferenceKey, effectiveAgent.turnAgent.model ?? null);
      await participants.restore({
        messages: history.initial.messages,
        runtime: runtimeIdentity,
        runtimeRevision: deploymentId
          ? `deployment:${deploymentId}`
          : await resolveRuntimeCompiledArtifactsVersionedCacheKey(bundle.compiledArtifactsSource),
        sessionStarted: initialEmissionState.sessionStarted,
        turn: startedBetweenTurns
          ? undefined
          : {
              sequence: initialEmissionState.sequence,
              turnId: activeTurnId(initialEmissionState),
            },
      });
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
      signInCompletions: readonly AuthorizationChallenge[] | undefined,
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
        participants,
        signInCompletions,
        historyProjector: history.projector,
        historyView: history.prepare(modelSession),
        instrumentation,
        modelResolutionScope: {
          moduleMap: bundle.moduleMap,
          nodeId: bundle.nodeId,
        },
        node: effectiveNode,
        titleAttributeWrite: pendingAttributes.title,
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
            const connectionState = turnPosition(currentProjection(ctx));
            try {
              if (connectionState.sessionStarted) {
                await participants.rehydrateConnections({
                  runtime: runtimeIdentity,
                  turn: isBetweenTurns(currentProjection(ctx))
                    ? undefined
                    : { sequence: connectionState.sequence, turnId: activeTurnId(connectionState) },
                });
              }
            } catch (error) {
              const recovered = await recoverDynamicConnectionRehydration({
                emit: handleEvent,
                error,
                projection: currentProjection(ctx),
                session: schemaSession,
              });
              if (recovered !== undefined) return recovered;
              throw error;
            }
            // A sign-in completes before the turn it resumes, in the first call only.
            const completions =
              firstCall && completedAuths !== undefined
                ? completedAuths.map(({ challenge }) => challenge)
                : undefined;
            return runHarnessStep(schemaSession, stepInput, completions);
          });
          // The waiting boundary may reach the client before this step returns.
          // Its settled result wins over a cancellation of that completed turn.
          if (result.settledTurn === undefined) throwIfTurnAborted(abortSignal);
          // The call's result carries the lifecycle it published, which batching reads.
          const saved = { ...result, session: saveSessionProjection(result.session, ctx) };
          completedModelCall = { result: saved, serializedContext: serializeContext(ctx) };
          return saved;
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
        initialSession,
        stepInput: resolved,
      });
    }

    // Re-stamp the current address after handlers add a continuation alias.
    const aliased = saveSessionProjection(
      dropClosedRecords(
        reconcileSessionContinuationToken(ctx, stepResult.session),
        currentProjection(ctx),
      ),
      ctx,
    );
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
