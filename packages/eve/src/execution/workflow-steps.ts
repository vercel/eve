import { AuthKey, TasksEnabledKey, TurnTaskDeliveryKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { getInstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import { matchAuthorizationCallbacks } from "#execution/authorization-callback-match.js";
import type { DurableStepResult } from "#execution/next-driver-action.js";
import {
  CallbackBaseUrlKey,
  clearPendingAuthorization,
  getPendingAuthorization,
  PendingAuthorizationResultKey,
} from "#harness/authorization.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import type { TurnStepInput } from "#execution/durable-session-migrations/turn-workflow.js";
import { isTaskOwnedSerializedContext } from "#execution/tasks/child/instructions.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { createExecutionHistoryView } from "#execution/history-view.js";
import {
  consumeDeliveryInstrumentationControls,
  prepareDeliveryInstrumentation,
} from "#execution/instrumentation-controls.js";
import { executePreparedTurnStep } from "#execution/execute-prepared-turn-step.js";
import { isTaskToolAvailable, TASK_UPDATE_TOOL_NAME } from "#runtime/framework-tools/tasks.js";

export type { TurnStepInput };

/**
 * Runs one atomic harness step inside a durable `"use step"` boundary.
 */
export async function turnStep(rawInput: TurnStepInput): Promise<DurableStepResult> {
  "use step";

  let input = rawInput;

  let durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  if (input.input?.kind === "deliver") {
    input = {
      ...input,
      input: consumeDeliveryInstrumentationControls(ctx, input.input),
    };
  }
  if (rawInput.input?.kind === "deliver") {
    ctx.set(TurnTaskDeliveryKey, "none");
  }
  const adapter = ctx.require(ChannelKey);
  const bundle = ctx.require(BundleKey);
  const tasksEnabled = bundle.resolvedAgent.config?.experimental?.tasks === true;
  ctx.set(TasksEnabledKey, tasksEnabled);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const taskUpdatesEnabled =
    isTaskOwnedSerializedContext(input.serializedContext) &&
    isTaskToolAvailable({
      disabledFrameworkTools: bundle.resolvedAgent.disabledFrameworkTools ?? [],
      hasAuthoredTool: effectiveAgent.turnAgent.tools.some(
        (tool) => tool.name === TASK_UPDATE_TOOL_NAME,
      ),
      tasksEnabled,
      toolName: TASK_UPDATE_TOOL_NAME,
    });

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
  // Completion events are emitted after `emit` is created below.
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
  const preparedInstrumentation = prepareDeliveryInstrumentation({
    adapter,
    agentName: bundle.turnAgent.id,
    ctx,
    delivery: rawInput.input,
    instrumentation,
    rootSessionId: initialSession.rootSessionId ?? initialSession.sessionId,
    sessionId: initialSession.sessionId,
  });

  return preparedInstrumentation.scope.run(() =>
    executePreparedTurnStep({
      adapter,
      bundle,
      completedAuths,
      ctx,
      durableSession,
      effectiveAgent,
      history,
      initialEmissionState,
      initialSession,
      input,
      pendingAuth,
      preparedInstrumentation,
      rawInput,
      tasksEnabled,
      taskUpdatesEnabled,
    }),
  );
}
