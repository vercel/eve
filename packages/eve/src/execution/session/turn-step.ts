import { bindTurnCallerContext } from "#subagents/parent-notification.js";
import { traceSessionHandover } from "#execution/session/handover-tracing.js";
import type { HandleEventFn } from "#harness/types.js";
import { deriveSessionTitle } from "#execution/eve-workflow-attributes.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";
import { defaultDeliverResult } from "#channel/adapter.js";
import { contextStorage } from "#context/container.js";
import { startSessionPrewarmers } from "#context/prewarm.js";
import { runStep, withContextScope } from "#context/run-step.js";
import { sessionProvider } from "#context/providers/session.js";
import { ConnectionRegistryKey, connectionProvider } from "#context/providers/connection.js";
import { sandboxProvider } from "#context/providers/sandbox.js";
import {
  AuthKey,
  ScheduleIdKey,
  ScheduleInstanceKey,
  OccurrenceIdKey,
  InitiatorAuthKey,
  SessionTitleKey,
  ParentSessionKey,
  SandboxKey,
  SessionPredecessorKey,
  SessionKey,
  CapabilitiesKey,
  ChannelDeliveryKey,
  ChannelInstrumentationKey,
  HandleEventKey,
  StaticModelReferenceKey,
  TurnDeliveryIdsKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { RuntimeActionSettlementTimesKey } from "#harness/runtime-action-settlement-state.js";
import { readPendingHistory, withoutPendingHistory } from "#execution/session/pending-history.js";
import * as agentTraceState from "#tracing/eve/agent-trace-context-store.js";
import { matchAuthorizationCallbacks } from "#execution/authorization-callback-match.js";
import { isTurnCancellation, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { setChannelContext } from "#execution/channel-context.js";
import { isBetweenTurns, storedProjection, turnPosition } from "#harness/session-machine/view.js";
import {
  currentProjection,
  enterSessionProjection,
  enterSessionProjectionAt,
  nextLinePosition,
  recordAppliedSession,
  saveSessionProjection,
} from "#harness/session-machine/current.js";
import { saveTransition, dropClosedRecords, sessionView } from "#harness/session-machine/commit.js";
import { matchSignIns, receive } from "#harness/session-machine/transitions.js";
import type { DeliverPayload } from "#channel/types.js";
import { coalesceTurnInputs, validateHarnessModelMessages } from "#harness/messages.js";
import type { HarnessSession, HarnessStepInput, StepInput, StepResult } from "#harness/types.js";
import { attributeAnswers } from "#execution/session/answer-caller.js";
import type {
  DurableStepResult,
  TurnStepInput,
  TurnStepResult,
} from "#execution/session/turn-step-types.js";
import { pausedOrParked, resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import {
  checksSessionEvents,
  foldOrphanedLines,
  openSessionEventPublisher,
  readOrphanedLines,
} from "#execution/publish-session-events.js";
import {
  readInterruptedAttempt,
  recoverInterruptedStep,
} from "#execution/session/interrupted-step.js";
import { stepDisagreement } from "#execution/session/step-decision-check.js";
import { createLogger } from "#internal/logging.js";
import { admitDeliveries, type DeliveryAdmission } from "#execution/session/delivery-facts.js";
import { getAdapterKind } from "#channel/adapter.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { fact } from "#harness/facts.js";
import { eventsOf } from "#harness/publication.js";
import { createTurnEventHandler } from "#execution/session/turn-event-handler.js";
import { applyReactionEffects, restoreReactions } from "#reactions/runner.js";
import { bindMemoryInstrumentation } from "#reactions/kinds/memory.js";
import { CallbackBaseUrlKey, PendingAuthorizationResultKey } from "#harness/authorization.js";
import { readHitlState } from "#harness/hitl/index.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import {
  createDurableSessionValues,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { buildRuntimeIdentity, createExecutionNodeStep } from "#execution/node-step.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import {
  resolveEffectiveAgentRuntime,
  resolveSessionUsageLimit,
} from "#execution/effective-agent-config.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession, refreshSessionFromTurnAgent } from "#execution/session.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { runModelCallBatch } from "#execution/model-call-batching.js";
import {
  createCancelledModelCallBatchResult,
  type CompletedModelCallCheckpoint,
} from "#execution/cancelled-model-call-batch.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";

export type { TurnStepInput };

const log = createLogger("execution.turn-step");

interface PendingStepAttributes {
  title?: Promise<void>;
}

/** Runs a bounded batch of harness model steps inside one durable `"use step"` boundary. */
export async function turnStep(input: TurnStepInput): Promise<TurnStepResult> {
  "use step";
  if (input.handover !== undefined) {
    traceSessionHandover(
      "inbox_unblocked",
      input.sessionState.sessionId,
      input.handover.attemptKey,
      {
        "eve.handoff.buffered_payload_count": input.handover.payloadCount,
        "eve.handoff.applied_at_ms": input.handover.appliedAtMs,
        "eve.handoff.applied_at_clock": "workflow",
      },
    );
  }
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
  const ctx = await deserializeContext(input.serializedContext);
  enterSessionProjection(ctx, durableSession.state);
  // An earlier attempt may have published past the checkpoint. The step recovers from what it
  // wrote instead of running the model and tools again, so every position and id follows it.
  const orphaned = await readOrphanedLines({
    sessionId: durableSession.sessionId,
    position: nextLinePosition(ctx),
    sessionWritable: input.sessionWritable,
    always: input.recover !== undefined,
  });
  const interrupted =
    orphaned.length > 0 || input.recover !== undefined
      ? readInterruptedAttempt(nextLinePosition(ctx), orphaned)
      : undefined;
  if (orphaned.length > 0) {
    enterSessionProjectionAt(ctx, foldOrphanedLines(currentProjection(ctx), orphaned));
  }
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
  let initialSession: HarnessSession = {
    ...hydrateDurableSession({
      durable: durableSession,
      turnAgent: effectiveAgent.turnAgent,
    }),
    history: validateHarnessModelMessages(input.history),
  };
  const instrumentation = bindSessionInstrumentation({
    agentName: effectiveAgent.turnAgent.id,
    ctx,
    rootSessionId: initialSession.rootSessionId ?? initialSession.sessionId,
    sessionId: initialSession.sessionId,
  });
  bindMemoryInstrumentation(ctx, instrumentation?.memory);
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
    instrumentation?.prepareDelivery(rawDelivery);
  }

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
    const sessionUsageLimit = resolveSessionUsageLimit(bundle);
    let compacted = false;
    const emitTurnEvent = createTurnEventHandler({
      abortSignal,
      canCancelTurn: input.input?.control === undefined,
      conversation: initialSession.history,
      hookCancellation,
      publisher,
    });
    const handleEvent: HandleEventFn = async (publication, messages) => {
      const completesCompaction = eventsOf(publication).some(
        (event) =>
          event.type === "context.settled" &&
          event.data.kind === "compaction" &&
          event.data.outcome === "completed",
      );
      if (completesCompaction) compacted = true;
      await emitTurnEvent(publication, messages);
    };
    const previousAdapterState =
      delivery !== undefined && !startedBetweenTurns
        ? structuredClone(adapterCtx.state)
        : undefined;
    // Run the adapter's deliver hook for each queued payload and coalesce
    // the resulting HarnessStepInput values; runtime results ride the same input.
    let resolved: HarnessStepInput | undefined;
    let admission: DeliveryAdmission | undefined;
    if (delivery !== undefined) {
      const delivered: { payload: DeliverPayload; input: StepInput | undefined }[] = [];
      // History left by `create()` joins the first message's turn. It leaves state only once a
      // deliver result carries it, so a dropped first message does not lose it.
      const pendingHistory = delivery.payloads.some((payload) => payload.message !== undefined)
        ? readPendingHistory(durableSession.state)
        : [];
      let accepted = 0;
      try {
        for (const payload of delivery.payloads) {
          const result = adapter.deliver
            ? await adapter.deliver(payload, adapterCtx)
            : defaultDeliverResult(payload);
          if (result === undefined || result === null) {
            delivered.push({ input: undefined, payload });
            continue;
          }
          // `history` is framework-owned, so a channel's deliver hook cannot drop or rewrite it.
          const history = [...(accepted === 0 ? pendingHistory : []), ...(payload.history ?? [])];
          accepted += 1;
          delivered.push({
            input: history.length === 0 ? result : { ...result, history },
            payload,
          });
        }
      } catch (error) {
        await instrumentation?.flush();
        throw error;
      }
      admission = admitDeliveries({
        channelKind: ctx.get(ChannelInstrumentationKey)?.kind ?? getAdapterKind(adapter),
        delivery: rawDelivery ?? delivery,
        status: (deliveryId) => currentProjection(ctx).view.deliveries[deliveryId]?.status,
        payloads: delivered,
      });
      if (accepted > 0 && pendingHistory.length > 0) {
        initialSession = { ...initialSession, state: withoutPendingHistory(initialSession.state) };
      }
      resolved =
        admission.inputs.length === 0 ? undefined : admission.inputs.reduce(coalesceTurnInputs);
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
      resolved = {
        ...resolved,
        delegatedUsage: runtimeResults.delegatedUsage,
        runtimeActionResults: runtimeResults.results,
      };
    }

    if (rawDelivery !== undefined) {
      const updatedAdapter = { ...adapter, state: { ...adapterCtx.state } };
      setChannelContext(ctx, updatedAdapter);
    }

    /** Whether the admission changed the session: its history or its sandbox. */
    let admissionChangedSession = false;
    /** The admission's facts: the session's start if it hasn't, then each delivery admitted. */
    const admissionFacts = (runtime: ReturnType<typeof buildRuntimeIdentity>): SessionEvent[] => {
      if (admission === undefined || admission.facts.length === 0) return [];
      const facts: SessionEvent[] = [];
      if (!turnPosition(currentProjection(ctx)).sessionStarted) {
        const parent = ctx.get(ParentSessionKey);
        const predecessor = ctx.get(SessionPredecessorKey);
        facts.push(
          fact("session.started", {
            parent:
              parent === undefined
                ? undefined
                : { callId: parent.callId, sessionId: parent.sessionId },
            predecessor,
            runtime,
          }),
        );
      }
      return [...facts, ...admission.facts];
    };
    /** The admission commit, with the session's providers its hooks read. */
    const publishAdmission = async (runtime: ReturnType<typeof buildRuntimeIdentity>) => {
      const facts = admissionFacts(runtime);
      if (facts.length === 0) return;
      // The admission commits before the step's framework context exists, and its hooks read
      // the session (`ctx.session`) like every other commit's. The session's start resolves
      // its dynamic connections into a registry, which the step's own scope rebuilds and
      // rehydrates, and its dynamic skills write their files to the sandbox, whose state the
      // step's scope resumes.
      const created = sessionProvider.create(ctx, initialSession);
      ctx.setVirtualContext(SessionKey, created.value);
      const registry = await connectionProvider.create(ctx, initialSession);
      if (registry !== undefined) ctx.setVirtualContext(ConnectionRegistryKey, registry.value);
      const sandbox = await sandboxProvider.create(ctx, initialSession);
      if (sandbox !== undefined) ctx.setVirtualContext(SandboxKey, sandbox.value);
      // A user-role instruction the session's start resolves stays in its slot until the step
      // builds the conversation, which takes it ahead of the turn's input.
      // Instrumentation hears the admission like any commit, so providers see the session start.
      const publish = instrumentation?.createHandleEvent({ handleEvent }) ?? handleEvent;
      try {
        await contextStorage.run(ctx, () => publish(facts));
      } finally {
        if (sandbox !== undefined) {
          const sandboxState = await sandbox.value.captureState();
          if (
            JSON.stringify(sandboxState) !== JSON.stringify(initialSession.sandboxState ?? null)
          ) {
            admissionChangedSession = true;
            initialSession = { ...initialSession, sandboxState };
          }
        }
      }
    };

    /**
     * A cancel stops the turn its input was selected for. Input it hadn't consumed yet joins that
     * turn first, opening it if need be, so the cancel settles each delivery with the turn and the
     * history that keeps the message agrees with the stream.
     */
    const consumeCancelledInput = async (): Promise<void> => {
      const projection = currentProjection(ctx);
      const waiting = (resolved?.deliveries ?? []).filter(
        ({ deliveryId }) => projection.view.deliveries[deliveryId]?.status === "admitted",
      );
      if (waiting.length === 0) return;
      const { events } = receive(sessionView(projection, initialSession.state), {
        deliveries: waiting,
      });
      // The turn is already stopping, so this commit's hooks have nothing left to cancel.
      const emit = createTurnEventHandler({
        abortSignal,
        canCancelTurn: false,
        conversation: initialSession.history,
        hookCancellation: new AbortController(),
        publisher,
      });
      const publish = instrumentation?.createHandleEvent({ handleEvent: emit }) ?? emit;
      await contextStorage.run(ctx, () => publish(events));
    };

    if (delivery !== undefined && resolved === undefined && startedBetweenTurns) {
      // Nothing here starts a turn, so a cancel has nothing to stop.
      await publishAdmission(buildRuntimeIdentity(effectiveNode)).catch(ignoreTurnCancellation);
      await instrumentation?.flush();
      const aliased = saveSessionProjection(
        reconcileSessionContinuationToken(ctx, initialSession),
        ctx,
      );
      const nextSerializedContext = serializeContext(ctx);
      const nextValues =
        aliased === initialSession && !admissionChangedSession
          ? { history: input.history, sessionState: input.sessionState }
          : createDurableSessionValues(aliased);

      return pausedOrParked(aliased, {
        serializedContext: nextSerializedContext,
        ...nextValues,
      });
    }

    const runtimeIdentity = buildRuntimeIdentity(effectiveNode);
    let restoration: Promise<void> | undefined;
    const prepareReactions = (session: HarnessSession): Promise<void> => {
      ctx.setVirtualContext(StaticModelReferenceKey, effectiveAgent.turnAgent.model ?? null);
      return (restoration ??= (async () => {
        try {
          const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
          const revision = deploymentId
            ? `deployment:${deploymentId}`
            : await resolveRuntimeCompiledArtifactsVersionedCacheKey(
                bundle.compiledArtifactsSource,
              );
          await contextStorage.run(ctx, () =>
            restoreReactions(ctx, { abortSignal, conversation: session.history, revision }),
          );
        } catch (error) {
          await instrumentation?.flush();
          throw error;
        }
      })());
    };
    if (interrupted !== undefined) {
      const recovered = await recoverInterruptedStep({
        admission: admissionFacts(runtimeIdentity),
        attempt: interrupted,
        control:
          input.input?.control === undefined
            ? undefined
            : { delivery: input.input.controlDelivery, kind: input.input.control },
        ctx,
        failed: input.recover,
        publish: async (events, session) => {
          const scoped = await withContextScope(ctx, session, async (current) => {
            await prepareReactions(current);
            const emit = createTurnEventHandler({
              abortSignal,
              canCancelTurn: false,
              conversation: current.history,
              hookCancellation: new AbortController(),
              publisher,
            });
            const publish = instrumentation?.createHandleEvent({ handleEvent: emit }) ?? emit;
            await publish(events);
            return { result: undefined, session: current };
          });
          return scoped.session;
        },
        session: initialSession,
        stepInput: resolved,
      }).catch(async (error: unknown) => {
        await instrumentation?.flush();
        throw error;
      });
      if ("result" in recovered) {
        await instrumentation?.flush();
        // The attempt that ended the session may have closed its stream already.
        if (recovered.result.action === "done") await publisher.writer.close().catch(() => {});
        return recovered.result;
      }
      initialSession = recovered.session;
      resolved = recovered.stepInput;
    }
    await prepareReactions(initialSession);

    try {
      await publishAdmission(runtimeIdentity);
    } catch (error) {
      // A hook's cancel on the admission stops the turn below, like a cancel that arrives now.
      if (!isTurnCancellation(error)) {
        await instrumentation?.flush();
        throw error;
      }
    }

    const modelCallsPerStep =
      bundle.resolvedAgent.config?.experimental?.workflow?.modelCallsPerStep ?? 1;
    const capabilities = ctx.get(CapabilitiesKey);

    const runHarnessStep = async (
      lifecycleSession: HarnessSession,
      stepInput: HarnessStepInput | undefined,
      signInCompletions: readonly AuthorizationChallenge[] | undefined,
    ): Promise<StepResult> => {
      const refreshedSession = refreshSessionFromTurnAgent({
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
        controlDelivery: input.input?.controlDelivery,
        createRuntime: createWorkflowRuntime,
        handleEvent,
        signInCompletions,
        typedAnswers: !hasDelegatedSessionContext(input.serializedContext),
        instrumentation,
        modelResolutionScope: {
          moduleMap: bundle.moduleMap,
          nodeId: bundle.nodeId,
        },
        node: effectiveNode,
        sessionUsageLimit,
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
            // Races session resources against the model call; their users wait for what remains.
            if (firstCall && input.input?.control === undefined) {
              startSessionPrewarmers(ctx, "turn");
            }
            ctx.setVirtualContext(HandleEventKey, handleEvent);
            ctx.setVirtualContext(StaticModelReferenceKey, effectiveAgent.turnAgent.model ?? null);
            const schemaSession =
              firstCall && resolved?.outputSchema !== undefined
                ? { ...enrichedSession, outputSchema: resolved.outputSchema }
                : enrichedSession;
            // The scope's providers start empty; the slots fill what they own.
            await applyReactionEffects(ctx);
            // A sign-in completes before the turn it resumes, in the first call only.
            const completions =
              firstCall && completedAuths !== undefined
                ? completedAuths.map(({ challenge }) => challenge)
                : undefined;
            const harnessResult = await runHarnessStep(schemaSession, stepInput, completions);
            // Only the step knows whether it stopped for an interaction; the tables say which.
            await publisher.finish({ announce: stoppedForPerson(harnessResult) });
            return harnessResult;
          });
          // The waiting boundary may reach the client before this step returns.
          // Its settled result wins over a cancellation of that completed turn.
          if (result.settledTurn === undefined) throwIfTurnAborted(abortSignal);
          // The call's result carries the lifecycle it published, which batching reads.
          const saved = { ...result, session: saveSessionProjection(result.session, ctx) };
          // A cut continuation starts from this completed call's private state.
          recordAppliedSession(ctx, saved.session);
          completedModelCall = { result: saved, serializedContext: serializeContext(ctx) };
          return saved;
        },
      });
    } catch (error) {
      if (!isTurnCancellation(error) && !abortSignal.aborted) {
        await instrumentation?.flush();
        throw error;
      }
      if (completedModelCall === undefined) await consumeCancelledInput();
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
    if (checksSessionEvents()) {
      const disagreement = stepDisagreement(durableResult, currentProjection(ctx).view);
      if (disagreement !== undefined && disagreement !== "dispatch-deferred")
        log.warn("a turn step's decision disagrees with the session's tables", { disagreement });
    }
    if (durableResult.action === "done") await publisher.writer.close();
    return compacted ? { ...durableResult, compacted: true } : durableResult;
  } finally {
    publisher.writer.release();
  }
}

/**
 * The step stopped for an interaction: it says so, or it stopped with nothing of its own to wait on,
 * and the tables say whether that's an interaction (`announceWaiting`).
 */
function stoppedForPerson(result: StepResult): boolean {
  if (result.held !== undefined) return result.held.kind === "request";
  return result.next === null && result.settledTurn === undefined;
}

/** A cancel the commit's hooks raised after it was written; the cancel already underway handles it. */
function ignoreTurnCancellation(error: unknown): void {
  if (!isTurnCancellation(error)) throw error;
}
