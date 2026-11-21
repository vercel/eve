import { checksSessionEvents } from "#shared/dev-checks.js";
import { createToolChannelTo } from "#execution/tools/channel-to.js";
import { channelOf } from "#definitions/frame.js";
import { bindTurnCallerContext } from "#subagents/parent-notification.js";
import type { Commit, HandleEventFn } from "#harness/types.js";
import { deriveSessionTitle } from "#execution/eve-workflow-attributes.js";
import type { EveAttributeValue } from "#runtime/attributes/normalize.js";
import { defaultDeliverResult } from "#channel/adapter.js";
import { type ContextContainer, contextStorage } from "#context/container.js";
import { startSessionPrewarmers } from "#context/prewarm.js";
import { runStep, withContextScope } from "#context/run-step.js";
import { sessionProvider } from "#context/providers/session.js";
import { ConnectionRegistryKey, connectionProvider } from "#context/providers/connection.js";
import { sandboxProvider, sessionSandboxIdleTimeoutMs } from "#context/providers/sandbox.js";
import { markSandboxRunning } from "#sandbox/state.js";
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
  ToolChannelKey,
  ToolStubsKey,
  TurnDeliveryIdsKey,
} from "#context/keys.js";
import { ChannelKey, requireCompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { sessionAgent } from "#definitions/agent.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { RuntimeActionSettlementTimesKey } from "#harness/runtime-action-settlement-state.js";
import { readPendingHistory, withoutPendingHistory } from "#execution/session/pending-history.js";
import * as agentTraceState from "#tracing/eve/agent-trace-context-store.js";
import { matchAuthorizationCallbacks } from "#execution/authorization-callback-match.js";
import {
  isTurnCancellation,
  throwIfTurnAborted,
  TurnCancelledError,
} from "#harness/turn-cancellation.js";
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
import {
  commitTransitions,
  saveTransition,
  dropClosedRecords,
  sessionView,
} from "#harness/session-machine/commit.js";
import { matchSignIns, receive } from "#harness/session-machine/transitions.js";
import type { DeliverPayload } from "#channel/types.js";
import { coalesceTurnInputs, validateHarnessModelMessages } from "#harness/messages.js";
import type { HarnessSession, HarnessStepInput, StepInput, StepResult } from "#harness/types.js";
import { attributeAnswers } from "#execution/session/answer-caller.js";
import { continueTurnAuth } from "#execution/session/principal.js";
import type {
  DurableStepResult,
  TurnStepInput,
  TurnStepResult,
} from "#execution/session/turn-step-types.js";
import { pausedOrParked, resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import {
  foldOrphanedLines,
  openSessionEventPublisher,
  readOrphanedLines,
  type Entered,
} from "#execution/publish-session-events.js";
import {
  readInterruptedAttempt,
  recoverInterruptedStep,
} from "#execution/session/interrupted-step.js";
import { stepDisagreement } from "#execution/session/step-decision-check.js";
import { createLogger } from "#internal/logging.js";
import { planAdmission, type DeliveryAdmission } from "#execution/session/delivery-facts.js";
import { getAdapterKind } from "#channel/adapter.js";
import { admitDeliveries } from "#harness/session-machine/deliveries.js";
import { eventsOf } from "#harness/publication.js";
import { createTurnEventHandler } from "#execution/session/turn-event-handler.js";
import { installDefinitions, restoreDefinitions } from "#definitions/kernel.js";
import { bindMemoryInstrumentation } from "#memory/definition.js";
import { CallbackBaseUrlKey, PendingAuthorizationResultKey } from "#harness/authorization.js";
import {
  ownCallbacks,
  readHitlState,
  ResumeSignInKey,
  settleSignIns,
  signInsAnswered,
  signInsEnded,
  type SignInAnswer,
} from "#harness/hitl/index.js";
import {
  createDurableSessionValues,
  readDurableSession,
} from "#execution/durable-session-store.js";
import {
  buildRuntimeIdentity,
  createExecutionNodeStep,
  type CreateRuntime,
} from "#execution/node-step.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession } from "#execution/session.js";
import { toolStubPlayback, type ToolStubHost } from "#execution/tool-stub-host.js";
import { ToolStubPlaybackKey } from "#context/providers/tool-stubs-key.js";
import { runModelCallBatch } from "#execution/model-call-batching.js";
import {
  createCancelledModelCallBatchResult,
  type CompletedModelCallCheckpoint,
} from "#execution/cancelled-model-call-batch.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import { signInInteractionId } from "#harness/interaction-facts.js";
import { SIGN_IN_DECLINED } from "#harness/hitl/sign-ins.js";
import { signInDelivery, type DurableHost } from "#execution/hosts.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type { AuthorizationCallback } from "#shared/connection-types.js";

export type { TurnStepInput };

const log = createLogger("execution.turn-step");

interface PendingStepAttributes {
  title?: Promise<void>;
  usage?: Promise<void>;
}

export interface SessionStepHost {
  readonly callbackBaseUrl?: string;
  setAttributes(attributes: Record<string, EveAttributeValue>): Promise<void>;
  readonly createRuntime: CreateRuntime;
  readonly toolStubs?: ToolStubHost;
  readonly deliver?: DurableHost["deliver"];
}

export function turnStepOn(
  host: SessionStepHost,
): (input: TurnStepInput) => Promise<TurnStepResult> {
  return async (input) =>
    await withSessionStateDelta(input, (state) =>
      runSessionStep(
        {
          ...state,
          serializedContext: bindTurnCallerContext(state.caller, state.serializedContext),
        },
        host,
      ),
    );
}

async function runSessionStep(
  input: Entered<TurnStepInput>,
  host: SessionStepHost,
): Promise<DurableStepResult> {
  const pendingAttributes: PendingStepAttributes = {};
  try {
    return await runSessionStepBody(input, pendingAttributes, host);
  } finally {
    await pendingAttributes.title;
    await pendingAttributes.usage;
  }
}

async function runSessionStepBody(
  input: Entered<TurnStepInput>,
  pendingAttributes: PendingStepAttributes,
  host: SessionStepHost,
): Promise<DurableStepResult> {
  const rawDelivery = input.input?.delivery;
  let delivery = rawDelivery;
  const runtimeResults = input.input?.runtimeResults;

  let durableSession = readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  enterSessionProjection(ctx, durableSession.state);
  const orphaned = await readOrphanedLines({
    sessionId: durableSession.sessionId,
    position: nextLinePosition(ctx),
    sessionWritable: input.sessionWritable,
    rerun: input.recover !== undefined || input.rerun,
  });
  const interrupted =
    orphaned.length > 0 || input.recover !== undefined
      ? readInterruptedAttempt(nextLinePosition(ctx), orphaned)
      : undefined;
  if (orphaned.length > 0) {
    enterSessionProjectionAt(ctx, foldOrphanedLines(currentProjection(ctx), orphaned));
  }
  const adapter = ctx.require(ChannelKey);
  const agent = sessionAgent(ctx);
  const bundle = requireCompiledBundle(ctx);

  if (host.callbackBaseUrl !== undefined) ctx.set(CallbackBaseUrlKey, host.callbackBaseUrl);

  const { signIns } = readHitlState(durableSession.state);
  let completedAuths: ReturnType<typeof matchAuthorizationCallbacks>["matches"] | undefined;
  if (signIns.length > 0 && delivery !== undefined) {
    const { matches, remainingPayloads } = matchAuthorizationCallbacks(signIns, delivery.payloads);
    delivery = { ...delivery, payloads: remainingPayloads };
    if (matches.length > 0) {
      const matchedAttemptIds = matches.map((match) => match.result.attemptId);
      const authResults = matches.map((match) => match.result);
      const baseUrl = ctx.get(CallbackBaseUrlKey);
      if (baseUrl !== undefined && host.deliver !== undefined) {
        const own = ownCallbacks(durableSession.sessionId, baseUrl);
        const tables = storedProjection(durableSession.state).view;
        await settleSignIns(
          signInDelivery(host.deliver),
          matches.flatMap(({ challenge, result }) => {
            const answer = ownSignInAnswer(tables, challenge, result.callback);
            if (answer !== undefined) return signInsAnswered(tables, answer, own);
            const error = result.callback.params["error"];
            return error === undefined
              ? []
              : signInsEnded(
                  tables,
                  { interactionId: signInInteractionId(challenge), reason: error },
                  own,
                );
          }),
        );
      }
      ctx.set(PendingAuthorizationResultKey, authResults);
      const view = sessionView(storedProjection(durableSession.state), durableSession.state);
      const transition = matchSignIns(view, { attemptIds: matchedAttemptIds });
      if (transition.events.length !== 0) throw new Error("matchSignIns must not emit events.");
      durableSession = saveTransition(durableSession, transition);
      completedAuths = matches;
      if (remainingPayloads.length === 0) delivery = undefined;
    }
  }

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

  if (delivery?.auth !== undefined) {
    ctx.set(AuthKey, delivery.auth ?? null);
    if (!ctx.has(InitiatorAuthKey)) ctx.set(InitiatorAuthKey, delivery.auth ?? null);
  }
  const requester =
    delivery === undefined
      ? completedAuths?.find(({ challenge }) => challenge.candidateId === undefined)?.challenge
          .requester
      : undefined;
  if (requester !== undefined) ctx.set(AuthKey, requester);
  let initialSession: HarnessSession = {
    ...hydrateDurableSession(durableSession),
    history: validateHarnessModelMessages(input.history),
  };
  const sandboxIdleTimeoutMs = (session: HarnessSession) =>
    sessionSandboxIdleTimeoutMs({
      agent,
      channelState: ctx.get(ChannelKey)?.state,
      sandboxState: session.sandboxState,
      sessionId: durableSession.sessionId,
    });
  const instrumentation = bindSessionInstrumentation({
    agentName: agent.id,
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
      pendingAttributes.title = host.setAttributes({ "$eve.title": title });
    }
  }

  if (rawDelivery !== undefined) {
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
  const hookCancellation = new AbortController();
  const abortSignal =
    input.abortSignal === undefined
      ? hookCancellation.signal
      : AbortSignal.any([input.abortSignal, hookCancellation.signal]);
  try {
    const effectiveNode = { ...bundle.graph.root, turnAgent: bundle.turnAgent };
    const sessionUsageLimit = agent.settings.limits?.sessionUsage;
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
    let resolved: HarnessStepInput | undefined;
    let admission: DeliveryAdmission | undefined;
    if (delivery !== undefined) {
      const delivered: { payload: DeliverPayload; input: StepInput | undefined }[] = [];
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
      admission = planAdmission({
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
    const answers =
      delivery?.auth === undefined
        ? undefined
        : attributeAnswers({
            owner: startedBetweenTurns ? undefined : (previousAuth ?? null),
            responder: delivery.auth,
            state: durableSession.state,
            stepInput: resolved,
          });
    if (answers !== undefined) {
      resolved = answers;
      if (!hadInitiator) ctx.delete(InitiatorAuthKey);
    }
    const ignoredActiveDelivery =
      delivery !== undefined && resolved === undefined && !startedBetweenTurns;
    let turnAuth = ctx.get(AuthKey);
    if (answers !== undefined || ignoredActiveDelivery) turnAuth = previousAuth;
    else if (delivery !== undefined && !startedBetweenTurns) {
      turnAuth =
        resolved?.message === undefined ? previousAuth : continueTurnAuth(previousAuth, turnAuth);
    }
    if (turnAuth === undefined) ctx.delete(AuthKey);
    else ctx.set(AuthKey, turnAuth);
    if (ignoredActiveDelivery) {
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

    let admissionChangedSession = false;
    const admissionFacts = (runtime: ReturnType<typeof buildRuntimeIdentity>): Commit => {
      if (admission === undefined || admitDeliveries(admission.deliveries).length === 0)
        return admitDeliveries([]);
      const parent = ctx.get(ParentSessionKey);
      return admitDeliveries(admission.deliveries, {
        start: turnPosition(currentProjection(ctx)).sessionStarted
          ? undefined
          : {
              parent:
                parent === undefined
                  ? undefined
                  : { callId: parent.callId, sessionId: parent.sessionId },
              predecessor: ctx.get(SessionPredecessorKey),
              runtime,
            },
      });
    };
    const publishAdmission = async (runtime: ReturnType<typeof buildRuntimeIdentity>) => {
      const facts = admissionFacts(runtime);
      if (facts.length === 0) return;
      const created = sessionProvider.create(ctx, initialSession);
      ctx.setVirtualContext(SessionKey, created.value);
      const registry = await connectionProvider.create(ctx, initialSession);
      if (registry !== undefined) ctx.setVirtualContext(ConnectionRegistryKey, registry.value);
      const sandbox = await sandboxProvider.create(ctx, initialSession);
      if (sandbox !== undefined) ctx.setVirtualContext(SandboxKey, sandbox.value);
      const publish = instrumentation?.createHandleEvent({ handleEvent }) ?? handleEvent;
      try {
        await contextStorage.run(ctx, () => publish(facts));
      } finally {
        await publisher.drain();
        await registry?.value.dispose();
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

    const consumeCancelledInput = async (): Promise<void> => {
      const projection = currentProjection(ctx);
      const waiting = (resolved?.deliveries ?? []).filter(
        ({ deliveryId }) => projection.view.deliveries[deliveryId]?.status === "admitted",
      );
      if (waiting.length === 0) return;
      const received = commitTransitions([
        receive(sessionView(projection, initialSession.state), { deliveries: waiting }),
      ]);
      const emit = createTurnEventHandler({
        abortSignal,
        canCancelTurn: false,
        conversation: initialSession.history,
        hookCancellation: new AbortController(),
        publisher,
      });
      const publish = instrumentation?.createHandleEvent({ handleEvent: emit }) ?? emit;
      await contextStorage.run(ctx, () => publish(received));
    };

    if (delivery !== undefined && resolved === undefined && startedBetweenTurns) {
      await publishAdmission(buildRuntimeIdentity(agent)).catch(ignoreTurnCancellation);
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

    const runtimeIdentity = buildRuntimeIdentity(agent);
    let restoration: Promise<void> | undefined;
    const prepareDefinitions = (session: HarnessSession): Promise<void> => {
      return (restoration ??= (async () => {
        try {
          const revision = await agent.revision();
          await contextStorage.run(ctx, () =>
            restoreDefinitions(ctx, { abortSignal, conversation: session.history, revision }),
          );
        } catch (error) {
          await instrumentation?.flush();
          throw error;
        }
      })());
    };
    if (interrupted !== undefined) {
      initialSession = markSandboxRunning(
        initialSession,
        await sandboxIdleTimeoutMs(initialSession),
      );
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
          const scoped = await withContextScope(
            ctx,
            session,
            async (current) => {
              await prepareDefinitions(current);
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
            },
            { drain: publisher.drain },
          );
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
        if (recovered.result.action === "done") await publisher.writer.close().catch(() => {});
        return recovered.result;
      }
      initialSession = recovered.session;
      resolved = recovered.stepInput;
    }
    await prepareDefinitions(initialSession);

    try {
      await publishAdmission(runtimeIdentity);
    } catch (error) {
      if (!isTurnCancellation(error)) {
        await instrumentation?.flush();
        throw error;
      }
    }

    const modelCallsPerStep = agent.settings.modelCallsPerStep ?? 1;
    const capabilities = ctx.get(CapabilitiesKey);

    const runHarnessStep = async (
      lifecycleSession: HarnessSession,
      stepInput: HarnessStepInput | undefined,
      signInCompletions: readonly AuthorizationChallenge[] | undefined,
    ): Promise<StepResult> => {
      const step = createExecutionNodeStep({
        steeringSignal: input.steeringSignal,
        abortSignal,
        capabilities,
        clearOnly: input.input?.control === "clear",
        compactOnly: input.input?.control === "compact",
        controlDelivery: input.input?.controlDelivery,
        createRuntime: host.createRuntime,
        handleEvent,
        signInCompletions,
        typedAnswers: !hasDelegatedSessionContext(input.serializedContext),
        instrumentation,
        modelResolutionScope: {
          moduleMap: bundle.moduleMap,
          nodeId: bundle.nodeId,
        },
        agent,
        node: effectiveNode,
        sessionUsageLimit,
        setAttributes: async (attributes) => {
          const previous = pendingAttributes.usage ?? pendingAttributes.title;
          pendingAttributes.usage = (async () => {
            await previous?.catch(() => {});
            await host.setAttributes(attributes);
          })().catch(() => {});
        },
      });
      return step(lifecycleSession, stepInput);
    };

    let completedModelCall: CompletedModelCallCheckpoint | undefined;
    let stepResult: StepResult;
    try {
      if (input.recover?.stopped === true) throw new TurnCancelledError();
      throwIfTurnAborted(abortSignal);
      stepResult = await runModelCallBatch({
        steeringSignal: input.steeringSignal,
        initialInput: resolved,
        initialSession,
        modelCallsPerStep,
        runStep: async ({ firstCall, session, stepInput }) => {
          const result = await runStep(
            ctx,
            session,
            async (enrichedSession) => {
              if (firstCall && input.input?.control === undefined) {
                startSessionPrewarmers(ctx, "turn");
              }
              ctx.setVirtualContext(HandleEventKey, handleEvent);
              if (host.deliver !== undefined)
                ctx.setVirtualContext(ResumeSignInKey, signInDelivery(host.deliver));
              const stubs = ctx.get(ToolStubsKey);
              if (stubs !== undefined)
                ctx.setVirtualContext(ToolStubPlaybackKey, toolStubPlayback(host.toolStubs, stubs));
              ctx.setVirtualContext(ToolChannelKey, {
                channel: channelOf(ctx),
                to: createToolChannelTo({
                  createRuntime: host.createRuntime,
                  delegated: hasDelegatedSessionContext(input.serializedContext),
                  loadAgent: () => agent,
                }),
              });
              const schemaSession =
                firstCall && resolved?.outputSchema !== undefined
                  ? { ...enrichedSession, outputSchema: resolved.outputSchema }
                  : enrichedSession;
              await installDefinitions(ctx);
              const completions =
                firstCall && completedAuths !== undefined
                  ? completedAuths.map(({ challenge }) => challenge)
                  : undefined;
              const harnessResult = await runHarnessStep(schemaSession, stepInput, completions);
              await publisher.finish({ announce: stoppedForPerson(harnessResult) });
              return harnessResult;
            },
            { drain: publisher.drain },
          );
          if (result.settledTurn === undefined) throwIfTurnAborted(abortSignal);
          const saved = { ...result, session: saveSessionProjection(result.session, ctx) };
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
      await publisher.drain();
      return createCancelledModelCallBatchResult({
        beforeBatchContext: input.serializedContext,
        checkpoint: completedModelCall,
        ctx,
        initialSession,
        sandboxIdleTimeoutMs: await sandboxIdleTimeoutMs(
          completedModelCall?.result.session ?? initialSession,
        ),
        stepInput: resolved,
      });
    }

    await publisher.drain();
    const aliased = saveSessionProjection(
      dropClosedRecords(
        reconcileSessionContinuationToken(ctx, stepResult.session),
        currentProjection(ctx),
      ),
      ctx,
    );
    agentTraceState.pruneAgentTraceState(ctx, aliased.sessionId, aliased.state);
    dropClosedSignInResults(ctx);
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
    await publisher.release();
  }
}

function dropClosedSignInResults(ctx: ContextContainer): void {
  const results = ctx.get(PendingAuthorizationResultKey);
  if (results === undefined) return;
  const { interactions } = currentProjection(ctx).view;
  const open = results.filter(
    (result) => interactions[signInInteractionId(result)]?.status === "open",
  );
  if (open.length === results.length) return;
  ctx.delete(PendingAuthorizationResultKey);
  if (open.length > 0) ctx.set(PendingAuthorizationResultKey, open);
}

function stoppedForPerson(result: StepResult): boolean {
  if (result.held !== undefined) return result.held.kind === "request";
  return result.next === null && result.settledTurn === undefined;
}

function ignoreTurnCancellation(error: unknown): void {
  if (!isTurnCancellation(error)) throw error;
}

function ownSignInAnswer(
  tables: SessionView,
  challenge: AuthorizationChallenge,
  callback: AuthorizationCallback,
): SignInAnswer | undefined {
  const interactionId = signInInteractionId(challenge);
  const signIn = tables.interactions[interactionId]?.request.signIn;
  const error = callback.params["error"];
  if (signIn === undefined || (error !== undefined && error !== SIGN_IN_DECLINED)) return undefined;
  return { interactionId, outcome: error === undefined ? "accepted" : "declined", signIn };
}
