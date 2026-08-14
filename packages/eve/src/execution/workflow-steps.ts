import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, defaultDeliverResult } from "#channel/adapter.js";
import type { DeliverHookPayload } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import {
  dispatchDynamicInstructionEvent,
  drainDynamicInstructionUserMessages,
  prepareDynamicInstructionPreamble,
} from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { preserveSerializedSessionDynamicModelSelection } from "#context/serialized-dynamic-model-selection.js";
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
import {
  emitTurnPreamble,
  getHarnessEmissionState,
  isHarnessBetweenTurns,
  setHarnessEmissionState,
} from "#harness/emission.js";
import {
  channelDeliveryErrorCode,
  instrumentChannelDelivery,
} from "#harness/channel-delivery-instrumentation.js";
import { getInstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import { preserveSerializedInstrumentationState } from "#harness/instrumentation/state.js";
import { RuntimeActionSettlementTimesKey } from "#harness/runtime-action-settlement-state.js";
import { preserveSerializedAgentTraceState } from "#tracing/agent-trace-context-store.js";
import { matchAuthorizationCallbacks } from "#execution/authorization-callback-match.js";
import { readTurnSleepDurationMs } from "#harness/turn-sleep.js";
import { isTurnCancellation, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { setChannelContext } from "#execution/channel-context.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import {
  getRuntimeActionKeysFromWorkflowInterrupt,
  isWorkflowRuntimeActionInterrupt,
} from "#harness/workflow-runtime-action-state.js";
import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession, SettledTurn, StepInput, StepResult } from "#harness/types.js";
import { getTurnUsageState, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";
import {
  createAuthorizationCompletedEvent,
  createSessionStartedEvent,
  encodeMessageStreamEvent,
  type UnstampedMessageStreamEvent,
  stampMessageStreamEvent,
  type MessageStreamEvent,
} from "#protocol/message.js";
import {
  CallbackBaseUrlKey,
  clearPendingAuthorization,
  getPendingAuthorization,
  PendingAuthorizationResultKey,
} from "#harness/authorization.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { forwardTaskEventToSessionCallback } from "#execution/task-event-callback.js";
import { resolveEffectiveOutputSchema } from "#execution/effective-output-schema.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import type { TurnStepInput } from "#execution/durable-session-migrations/turn-workflow.js";
import { buildRuntimeIdentity, createExecutionNodeStep } from "#execution/node-step.js";
import { appendTaskAgentAnnouncement } from "#execution/tasks/parent/agent-views.js";
import { prepareWorkflowPreambleTrace } from "#execution/workflow-trace-context.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { recordSubagentUsageSpans } from "#execution/subagent-usage-span.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession, refreshSessionFromTurnAgent } from "#execution/session.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";

const TASK_DONE_WITH_PENDING_INPUT_ERROR_MESSAGE =
  "Task mode cannot complete while input requests remain pending.";

/**
 * Result of one durable harness step, consumed by the turn workflow.
 *
 * `park` carries the pending fields needed to choose a
 * {@link import("#execution/next-driver-action.js").NextDriverAction} without re-reading state.
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
      /**
       * Usage the final turn added beyond what earlier settled turns already
       * reported; feeds the terminal `AgentTurnOutcome` for conversation
       * children. Task sessions settle once, so their callers read `usage`.
       */
      readonly usageDelta?: TokenUsage;
    }
  | {
      readonly action: "cancelled";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly action: "park";
      readonly authorizationAttemptIds?: readonly string[];
      readonly authorizationNames?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly pendingRuntimeActionKeys?: readonly string[];
      /**
       * Selects the dispatch step for `pendingRuntimeActionKeys`:
       * `dispatchTaskStep` when the agent runs `experimental.tasks`,
       * `dispatchRuntimeActionsStep` otherwise (including when absent).
       */
      readonly tasksEnabled?: boolean;
      readonly sleepDurationMs?: number;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
      readonly settled?: SettledTurn;
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
  const tasksEnabled = bundle.resolvedAgent.config?.experimental?.tasks === true;
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
  let completedAuths: ReturnType<typeof matchAuthorizationCallbacks>["matches"] | undefined;
  if (pendingAuth && input.input?.kind === "deliver") {
    const { matches, remainingPayloads } = matchAuthorizationCallbacks(
      pendingAuth,
      input.input.payloads,
    );
    input = { ...input, input: { ...input.input, payloads: remainingPayloads } };
    if (matches.length > 0) {
      const authResults = matches.map((match) => match.result);
      ctx.set(PendingAuthorizationResultKey, authResults);
      durableSession = {
        ...durableSession,
        state: clearPendingAuthorization(
          durableSession.state,
          authResults.map((result) => result.attemptId ?? result.name),
        ),
      };
      completedAuths = matches;
      if (remainingPayloads.length === 0) {
        input = { ...input, input: undefined };
      }
    }
  }

  // Apply deliver-time auth ferried via `resumeHook` (initial-turn
  // input has no auth; it was seeded by buildRunContext).
  if (input.input?.kind === "deliver" && input.input.auth !== undefined) {
    ctx.set(AuthKey, input.input.auth ?? null);
  }

  const initialSession = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: effectiveAgent.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const instrumentation = getInstrumentationRuntime();
  const initialEmissionState = getHarnessEmissionState(initialSession.state);

  if (rawInput.input?.kind === "deliver") {
    await contextStorage.run(ctx, () =>
      instrumentChannelDelivery({
        agentName: bundle.turnAgent.id,
        ctx,
        delivery: rawInput.input as DeliverHookPayload,
        hooks: instrumentation?.hooks,
        rootSessionId: initialSession.rootSessionId ?? initialSession.sessionId,
        sequence: initialEmissionState.sequence,
        sessionId: initialSession.sessionId,
        turnId: activeTurnId(initialEmissionState),
      }),
    );
  }

  const failChannelDeliveries = async (error: unknown): Promise<void> => {
    await contextStorage.run(ctx, () =>
      instrumentChannelDelivery({
        ctx,
        error,
        errorCode: channelDeliveryErrorCode(error),
        hooks: instrumentation?.hooks,
        includeTurn: false,
        outcome: "failed",
      }),
    );
    await instrumentation?.forceFlush();
  };
  const adapterCtx = buildAdapterContext(adapter, ctx);

  // Run the adapter's deliver hook for each queued payload and
  // coalesce the resulting StepInput values.
  let resolved: StepInput | undefined;
  if (input.input?.kind === "deliver") {
    const results: StepInput[] = [];
    try {
      for (const payload of input.input.payloads) {
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
  } else if (input.input?.kind === "runtime-action-result") {
    recordSubagentUsageSpans(input.input.results);
    if (input.input.acceptedAtMsByCallId !== undefined) {
      ctx.set(RuntimeActionSettlementTimesKey, input.input.acceptedAtMsByCallId);
    }
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
    await contextStorage.run(ctx, () =>
      instrumentChannelDelivery({
        ctx,
        hooks: instrumentation?.hooks,
        includeTurn: false,
        outcome: "completed",
      }),
    );
    await instrumentation?.forceFlush();
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
      tasksEnabled,
    };
  }

  const hookRegistry = bundle.hookRegistry;
  const dynamicInstructionsResolvers = bundle.resolvedAgent.dynamicInstructionsResolvers ?? [];
  const dynamicSkillResolvers = bundle.resolvedAgent.dynamicSkillResolvers ?? [];
  const dynamicSubagentResolvers = bundle.subagentRegistry.dynamicResolvers ?? [];
  const persistentSubagentSessions =
    tasksEnabled || bundle.resolvedAgent.config?.experimental?.subagentPersistentSessions === true;
  const dynamicToolResolvers = bundle.resolvedAgent.dynamicToolResolvers ?? [];
  const effectiveNode = {
    ...bundle.graph.root,
    turnAgent: effectiveAgent.turnAgent,
  };
  const runtimeIdentity = buildRuntimeIdentity(effectiveNode);
  try {
    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
    const dynamicRuntimeRevision = deploymentId
      ? `deployment:${deploymentId}`
      : await resolveRuntimeCompiledArtifactsVersionedCacheKey(bundle.compiledArtifactsSource);
    const sessionStarted = initialEmissionState.sessionStarted;

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
          persistentSessions: persistentSubagentSessions,
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
  } catch (error) {
    await failChannelDeliveries(error);
    throw error;
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
    // Task children report HITL and authorization transitions to their
    // parent's session callback before local emission, so the parent's
    // task run can block/unblock the task under one durable decision.
    await forwardTaskEventToSessionCallback(ctx, event);
    const emitted = await emit(event);
    await dispatchStreamEventHooks({ ctx, registry: hookRegistry, event: emitted });
    if (emitted.type !== "step.started") {
      await dispatchDynamicModelEvent({
        ctx,
        dynamicModel: effectiveAgent.turnAgent.dynamicModel,
        event: emitted,
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
      persistentSessions: persistentSubagentSessions,
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
      let schemaSession = resolveEffectiveOutputSchema({
        agentOutputSchema: effectiveAgent.turnAgent.outputSchema,
        input: resolved,
        mode,
        session: enrichedSession,
      });
      if (completedAuths) {
        let emissionState = getHarnessEmissionState(schemaSession.state);
        if (isHarnessBetweenTurns(schemaSession)) {
          prepareDynamicInstructionPreamble(ctx, schemaSession.history);
          let instructionMessages: readonly import("ai").ModelMessage[] = [];
          const traceContext = await prepareWorkflowPreambleTrace({
            ctx,
            emissionState,
            runtimeIdentity,
            session: schemaSession,
          });
          try {
            emissionState = await emitTurnPreamble(
              handleEvent,
              {},
              emissionState,
              runtimeIdentity,
              traceContext,
            );
          } finally {
            instructionMessages = drainDynamicInstructionUserMessages(ctx);
            schemaSession = {
              ...schemaSession,
              history: [...schemaSession.history, ...instructionMessages],
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
        const modelSession = tasksEnabled
          ? await appendTaskAgentAnnouncement(refreshedSession)
          : refreshedSession;

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
        return step(modelSession, stepInput);
      };

      return runHarnessStep(schemaSession, resolved);
    });
  } catch (error) {
    if (!isTurnCancellation(error)) {
      await failChannelDeliveries(error);
      throw error;
    }
    writer.releaseLock();
    // Trace and instrumentation state are needed by the cancellation
    // epilogue to close the operation the discarded step opened.
    // The session model is also kept because `session.started` is not emitted
    // again after this cancellation settles.
    const interrupted = serializeContext(ctx);
    return {
      action: "cancelled",
      serializedContext: preserveSerializedInstrumentationState(
        preserveSerializedAgentTraceState(
          preserveSerializedSessionDynamicModelSelection(input.serializedContext, interrupted),
          interrupted,
        ),
        interrupted,
      ),
      sessionState: input.sessionState,
    };
  }

  // Re-stamp the in-memory session's continuation token in case a
  // handler called `session.continuation.rekey(...)` (eg. Slack auto-anchor).
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
    if (mode === "task" && hasPendingInputBatch(stepResult.session.state)) {
      writer.releaseLock();
      throw new Error(TASK_DONE_WITH_PENDING_INPUT_ERROR_MESSAGE);
    }
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
      usageDelta: takeSessionUsageDelta(stepResult.session).delta,
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

    const pending = derivePendingState(stepResult.session);

    // `settledTurn` is the harness's explicit settlement verdict. Pending
    // state may predate this turn, while newly created parks omit the verdict.
    // `usage` carries only this turn's delta: the take marks the totals
    // reported, so a persistent child never re-reports earlier spend.
    if (stepResult.settledTurn !== undefined) {
      const { delta, session: reportedSession } = takeSessionUsageDelta(stepResult.session);
      return {
        action: "park",
        ...pending,
        ...sleepTransition,
        serializedContext: nextSerializedContext,
        sessionState: createDurableSessionState({ session: reportedSession }),
        settled: {
          output: stepResult.settledTurn.output,
          isError: stepResult.settledTurn.isError,
          usage: delta,
        },
        tasksEnabled,
      };
    }

    return {
      action: "park",
      ...pending,
      ...sleepTransition,
      serializedContext: nextSerializedContext,
      sessionState: nextState,
      tasksEnabled,
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
  readonly authorizationAttemptIds?: readonly string[];
  readonly authorizationNames?: readonly string[];
  readonly hasPendingAuthorization: boolean;
  readonly hasPendingInputBatch: boolean;
  readonly pendingRuntimeActionKeys?: readonly string[];
} {
  const batch = getPendingRuntimeActionBatch(session.state);
  const pendingAuth = getPendingAuthorization(session.state);
  const base = {
    authorizationAttemptIds: pendingAuth?.challenges.flatMap((challenge) =>
      challenge.attemptId === undefined ? [] : [challenge.attemptId],
    ),
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
