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
  rebindMissingCompiledDynamicToolCallbacks,
  refreshDynamicSessionToolsForRuntimeRevision,
} from "#context/dynamic-tool-lifecycle.js";
import { dispatchMemoryLifecycleEvent } from "#context/memory-event-lifecycle.js";
import {
  AuthKey,
  CapabilitiesKey,
  HandleEventKey,
  ModeKey,
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicToolRuntimeRevisionKey,
  TasksEnabledKey,
  TurnTaskDeliveryKey,
  TurnTaskStateKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
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
import { observeSessionActivity } from "#execution/session-activity-projection.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import {
  getRuntimeActionKeysFromWorkflowInterrupt,
  isWorkflowRuntimeActionInterrupt,
} from "#harness/workflow-runtime-action-state.js";
import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import type { HarnessSession, StepInput, StepResult } from "#harness/types.js";
import { getTurnUsageState, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import type { DurableStepResult } from "#execution/next-driver-action.js";
import { derivePendingState } from "#execution/pending-turn-state.js";
import {
  createAuthorizationCompletedEvent,
  createSessionStartedEvent,
  createTurnStartedEvent,
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
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import type { TurnStepInput } from "#execution/durable-session-migrations/turn-workflow.js";
import { buildRuntimeIdentity, createExecutionNodeStep } from "#execution/node-step.js";
import { appendTaskAgentAnnouncement } from "#execution/tasks/parent/agent-views.js";
import {
  resolveInitiatingTaskContext,
  resolveTaskDeliveryContext,
} from "#tasks/delivery-context.js";
import {
  readRetainedBackgroundToolResult,
  runBackgroundStep,
} from "#execution/tasks/parent/tool-execution.js";
import {
  isTaskOwnedSerializedContext,
  TASK_UPDATE_SESSION_INSTRUCTION,
} from "#execution/tasks/child/instructions.js";
import { prepareWorkflowPreambleTrace } from "#execution/workflow-trace-context.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { recordSubagentUsageSpans } from "#execution/subagent-usage-span.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession, refreshSessionFromTurnAgent } from "#execution/session.js";
import { createExecutionHistoryView } from "#execution/history-view.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { preserveCancelledTurnMessage } from "#execution/cancelled-turn-message.js";
import { TASK_UPDATE_TOOL_NAME } from "#tools/framework/task-contract.js";

const TASK_DONE_WITH_PENDING_INPUT_ERROR_MESSAGE =
  "Task mode cannot complete while input requests remain pending.";

export type { TurnStepInput };

/** Runs one atomic harness step inside a durable `"use step"` boundary. */
export async function turnStep(rawInput: TurnStepInput): Promise<DurableStepResult> {
  "use step";

  let input = rawInput;

  let durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  if (rawInput.input?.kind === "deliver") {
    ctx.set(TurnTaskDeliveryKey, "none");
    ctx.delete(TurnTaskStateKey);
  }
  const adapter = ctx.require(ChannelKey);
  const bundle = ctx.require(BundleKey);
  const tasksEnabled = bundle.resolvedAgent.config?.experimental?.tasks === true;
  ctx.set(TasksEnabledKey, tasksEnabled);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const taskUpdatesEnabled =
    isTaskOwnedSerializedContext(input.serializedContext) &&
    tasksEnabled &&
    effectiveAgent.turnAgent.tools.some(
      (tool) =>
        tool.kind === "authored-tool" &&
        tool.owner.kind === "framework" &&
        tool.name === TASK_UPDATE_TOOL_NAME,
    );

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

  // Resolve authorization callbacks before the adapter sees the delivery.
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
  const history = createExecutionHistoryView(initialSession);
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

  if (
    resolved !== undefined &&
    rawInput.input?.kind === "deliver" &&
    rawInput.input.taskDeliveryId !== undefined
  ) {
    const taskContext = resolveTaskDeliveryContext({
      state: durableSession.state,
      taskDeliveryId: rawInput.input.taskDeliveryId,
    });
    if (taskContext !== undefined) {
      ctx.set(TurnTaskDeliveryKey, taskContext.phase);
      resolved = {
        ...resolved,
        context: [...(resolved.context ?? []), taskContext.context],
      };
    }
  }

  if (tasksEnabled && ctx.get(TurnTaskDeliveryKey) === "none") {
    const taskContext = resolveInitiatingTaskContext({
      state: durableSession.state,
      turnId: activeTurnId(initialEmissionState),
    });
    if (taskContext !== undefined) {
      ctx.set(TurnTaskDeliveryKey, taskContext.phase);
      ctx.set(TurnTaskStateKey, taskContext.context);
    }
  }

  // Persist adapter-state mutations across the step boundary.
  if (input.input?.kind === "deliver") {
    const updatedAdapter = { ...adapter, state: { ...adapterCtx.state } };
    setChannelContext(ctx, updatedAdapter);
  }

  // Adapter handled the delivery inline; re-park and skip unchanged snapshot writes.
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
  const dynamicConnections = bindDynamicConnections(ctx, bundle.resolvedAgent);
  const dynamicInstructionsResolvers = bundle.resolvedAgent.dynamicInstructionsResolvers ?? [];
  const dynamicSkillResolvers = bundle.resolvedAgent.dynamicSkillResolvers ?? [];
  const dynamicSubagentResolvers = bundle.subagentRegistry.dynamicResolvers ?? [];
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
          messages: history.initial.messages,
          runtimeRevision: dynamicRuntimeRevision,
        }),
        refreshDynamicSessionToolsForRuntimeRevision({
          ctx,
          resolvers: dynamicToolResolvers,
          event: refreshEvent,
          messages: history.initial.messages,
          runtimeRevision: dynamicRuntimeRevision,
        }),
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

  const writer = input.parentWritable.getWriter();

  // Persisted chunks and hooks must agree on the stamped id.
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
    // A remote task's parent owns its HITL. Forward blocking events over
    // the task callback and keep them out of the child's local channel;
    // otherwise two TUIs can present and answer the same request.
    const forwardedToTaskParent = await forwardTaskEventToSessionCallback(ctx, event);
    const emitted = forwardedToTaskParent ? stampMessageStreamEvent(event) : await emit(event);
    const lifecycleMessages = await dispatchMemoryLifecycleEvent({
      abortSignal: input.abortSignal,
      appRoot: effectiveNode.agent?.metadata?.appRoot ?? "",
      ctx,
      event,
      memories: effectiveNode.agent?.memories ?? [],
      messages,
      nodeId: bundle.nodeId ?? "__root__",
    });
    void observeSessionActivity({ ctx, event: emitted, sessionId: initialSession.sessionId });
    await dispatchStreamEventHooks({ ctx, registry: hookRegistry, event: emitted });
    if (emitted.type !== "step.started") {
      await dispatchDynamicModelEvent({
        ctx,
        dynamicModel: effectiveAgent.turnAgent.dynamicModel,
        event: emitted,
        messages: lifecycleMessages,
        scope: {
          moduleMap: bundle.moduleMap,
          nodeId: bundle.nodeId,
        },
      });
    }
    await dynamicConnections.dispatch(emitted, lifecycleMessages);
    await dispatchDynamicSubagentEvent({
      ctx,
      resolvers: dynamicSubagentResolvers,
      event: emitted,
      messages: lifecycleMessages,
    });
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: dynamicToolResolvers,
      event: emitted,
      messages: lifecycleMessages,
    });
    await dispatchDynamicSkillEvent({
      ctx,
      resolvers: dynamicSkillResolvers,
      event: emitted,
      messages: lifecycleMessages,
    });
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: dynamicInstructionsResolvers,
      event: emitted,
      messages: lifecycleMessages,
    });
  };

  const mode = ctx.require(ModeKey);

  let stepResult: StepResult;
  try {
    // A signal already aborted at entry (cancellation during an in-line
    // runtime-action wait) must settle before the park-resume stages run,
    // or the pending batch would re-park and later re-dispatch.
    throwIfTurnAborted(input.abortSignal);
    stepResult = await runBackgroundStep(ctx, initialSession, async (enrichedSession) => {
      ctx.setVirtualContext(HandleEventKey, handleEvent);
      let schemaSession = resolveEffectiveOutputSchema({
        agentOutputSchema: effectiveAgent.turnAgent.outputSchema,
        input: resolved,
        mode,
        session: enrichedSession,
      });
      await dynamicConnections.rehydrate(
        initialEmissionState,
        runtimeIdentity,
        history.messages(schemaSession),
        isHarnessBetweenTurns(schemaSession),
      );
      if (completedAuths) {
        let emissionState = getHarnessEmissionState(schemaSession.state);
        if (isHarnessBetweenTurns(schemaSession)) {
          prepareDynamicInstructionPreamble(ctx, history.messages(schemaSession));
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
          systemPromptAdditions: taskUpdatesEnabled ? [TASK_UPDATE_SESSION_INSTRUCTION] : undefined,
          turnAgent: effectiveAgent.turnAgent,
        });
        const modelSession = tasksEnabled
          ? await appendTaskAgentAnnouncement(refreshedSession, history.messages(refreshedSession))
          : refreshedSession;

        const step = createExecutionNodeStep({
          abortSignal: input.abortSignal,
          capabilities,
          clearOnly: input.input?.kind === "clear",
          compactOnly: input.input?.kind === "compact",
          createRuntime: createWorkflowRuntime,
          handleEvent,
          historyProjector: history.projector,
          historyView: history.prepare(modelSession),
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
    const retained = readRetainedBackgroundToolResult(ctx);
    const cancelledSession = await preserveCancelledTurnMessage(
      retained?.backgroundTaskSession ?? initialSession,
      resolved,
    );
    return {
      action: "cancelled",
      ...(retained === undefined
        ? {}
        : {
            backgroundTaskState: createDurableSessionState({ session: cancelledSession }),
            backgroundTasks: retained.backgroundTasks,
          }),
      serializedContext: preserveSerializedInstrumentationState(
        preserveSerializedAgentTraceState(
          preserveSerializedSessionDynamicModelSelection(input.serializedContext, interrupted),
          interrupted,
        ),
        interrupted,
      ),
      sessionState: createDurableSessionState({ session: cancelledSession }),
    };
  }

  // Re-stamp if a handler called `session.continuation.rekey(...)` (eg. Slack auto-anchor).
  const rekeyed = reconcileSessionContinuationToken(ctx, stepResult.session);
  const nextSerializedContext = serializeContext(ctx);
  stepResult = { ...stepResult, session: rekeyed };

  const nextState = createDurableSessionState({ session: stepResult.session });
  const sleepDurationMs = readTurnSleepDurationMs(ctx);
  const sleepTransition = sleepDurationMs === undefined ? {} : { sleepDurationMs };
  const backgroundTransition =
    stepResult.backgroundTasks === undefined || stepResult.backgroundTaskSession === undefined
      ? {}
      : {
          backgroundTaskState: createDurableSessionState({
            session: stepResult.backgroundTaskSession,
          }),
          backgroundTasks: stepResult.backgroundTasks,
        };

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
      ...backgroundTransition,
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
        ...backgroundTransition,
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
        ...backgroundTransition,
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
      ...backgroundTransition,
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
    ...backgroundTransition,
    ...sleepTransition,
    serializedContext: nextSerializedContext,
    sessionState: nextState,
  };
}
