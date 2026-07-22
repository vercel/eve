import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, defaultDeliverResult } from "#channel/adapter.js";
import type { DeliverPayload, HookPayload } from "#channel/types.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { AuthKey, CapabilitiesKey, ModeKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { runStep } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { isTurnCancellation, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { setChannelContext } from "#execution/channel-context.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import { classifyParkedSession, withOutcomeState } from "#harness/step-result.js";
import type { GenerateOutcome, HarnessSession, StepInput } from "#harness/types.js";
import { getTurnUsageState, toUsage } from "#harness/turn-tag-state.js";
import type { JsonObject } from "#shared/json.js";
import type { RunMode } from "#shared/run-mode.js";
import {
  createAuthorizationCompletedEvent,
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
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { createNodeGenerate, type CreateRuntime } from "#execution/node-generate.js";
import { recordSubagentUsageSpans } from "#execution/subagent-usage-span.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession, refreshSessionFromTurnAgent } from "#execution/session.js";
import type { EveAttributeWriter } from "#runtime/attributes/normalize.js";
import type { EveLoopTypes, SessionState, TurnStepResult } from "#internal/loops/types.js";

/**
 * Inputs for one harness step, with every engine-owned capability injected:
 * the pre-read durable session, the resolved callback base URL, the runtime
 * constructor for delegated child runs, and the observability attribute
 * writer. The operation itself never touches a Workflow primitive.
 */
export interface TurnStepOperationInput {
  /** Cancellation signal forwarded into the step. */
  readonly abortSignal?: AbortSignal;
  /** Callback base URL for tool-execution hooks, when the host knows one. */
  readonly callbackBaseUrl: string | undefined;
  /** Runtime constructor used to start delegated child runs. */
  readonly createRuntime: CreateRuntime;
  /** The durable session, pre-read by the host from `sessionState`. */
  readonly durableSession: DurableSession;
  readonly input: HookPayload | undefined;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  /** Attribute sink, or `undefined` when the host has no attribute store. */
  readonly writeEveAttributes: EveAttributeWriter | undefined;
}

/**
 * Runs one atomic harness step: fold the delivery in, run the model with
 * its tools, and return the classified {@link TurnStepResult} projected
 * onto the serialized session cursors ({@link SessionState}).
 *
 * A harness cancellation throw converts into the `cancelled` arm so the
 * engine never classifies the abort as a step failure or retries it; the
 * epilogue runs in `settleCancelledTurnStep`.
 *
 * Engine-neutral by construction — the caller owns the durable boundary
 * (e.g. a Workflow `"use step"`), session reading, and retry policy.
 */
export async function executeTurnStepOperation(
  rawInput: TurnStepOperationInput,
): Promise<TurnStepResult> {
  let input = rawInput;

  let durableSession = rawInput.durableSession;
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const bundle = ctx.require(BundleKey);

  // Populate the callback base URL so getHookUrl() works during tool
  // execution. The host resolves it (eve's active local origin over
  // engine metadata fallback); outside an engine context it is undefined
  // and getHookUrl() returns undefined.
  if (input.callbackBaseUrl !== undefined) {
    ctx.set(CallbackBaseUrlKey, input.callbackBaseUrl);
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
    const nextState =
      rekeyed === initialSession
        ? input.sessionState
        : createDurableSessionState({ session: rekeyed });

    return withOutcomeState<EveLoopTypes>(
      classifyParkedSession(rekeyed),
      toSessionState(nextState, serializeContext(ctx)),
    );
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
    if (emitted.type !== "step.started") {
      await dispatchDynamicModelEvent({
        ctx,
        dynamicModel: bundle.turnAgent.dynamicModel,
        event: emitted,
        fallback: bundle.turnAgent.model,
        messages: messages ?? [],
        scope: {
          moduleMap: bundle.moduleMap,
          nodeId: bundle.nodeId,
        },
      });
    }
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

  let generated: GenerateOutcome;
  try {
    // A signal already aborted at entry (cancellation during an in-line
    // runtime-action wait) must settle before the park-resume stages run,
    // or the pending batch would re-park and later re-dispatch.
    throwIfTurnAborted(input.abortSignal);
    generated = await runStep(ctx, initialSession, async (enrichedSession) => {
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
      ): Promise<GenerateOutcome> => {
        const refreshedSession = refreshSessionFromTurnAgent({
          compactionOverrides: {
            thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
          },
          session: lifecycleSession,
          turnAgent: bundle.turnAgent,
        });

        const step = createNodeGenerate({
          abortSignal: input.abortSignal,
          capabilities,
          createRuntime: input.createRuntime,
          handleEvent,
          mode,
          modelResolutionScope: {
            moduleMap: bundle.moduleMap,
            nodeId: bundle.nodeId,
          },
          node: bundle.graph.root,
          workflowMaxSubagents: refreshedSession.workflowMaxSubagents,
          writeEveAttributes: input.writeEveAttributes,
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
      state: toSessionState(input.sessionState, input.serializedContext),
    };
  }

  // Re-stamp the in-memory session's continuation token in case a
  // handler called `setContinuationToken(...)` (eg. Slack auto-anchor).
  const rekeyed = reconcileSessionContinuationToken(ctx, generated.state);
  const state = toSessionState(
    createDurableSessionState({ session: rekeyed }),
    serializeContext(ctx),
  );

  if (generated.action === "done") {
    await writer.close();
    const sessionTotals = getTurnUsageState(rekeyed.state)?.session;
    return {
      action: "done",
      output: generated.output,
      isError: generated.isError,
      state,
      usage: sessionTotals === undefined ? undefined : toUsage(sessionTotals),
    };
  }

  writer.releaseLock();
  return withOutcomeState<EveLoopTypes>(generated, state);
}

function toSessionState(
  durable: DurableSessionState,
  serializedContext: Record<string, unknown>,
): SessionState {
  return { durable, serializedContext };
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
