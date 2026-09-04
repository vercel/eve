import {
  holdingWorkflowReference,
  activityCollectorWorkflowReference,
} from "#execution/workflow-references.js";
import {
  acceptSubmission,
  dispatchSessionCommand,
  dispatchSessionCommandByToken,
  type DispatchedSubmission,
} from "#execution/session/ingress.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-start.js";
import { createHash, randomBytes } from "node:crypto";

import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import { getChannelActivityPresentation } from "#channel/activity-renderer.js";
import type {
  CancelTurnInput,
  CancelTurnResult,
  DispatchContinuationInput,
  DispatchSessionInput,
  GetEventStreamOptions,
  RunHandle,
  RunInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { ActivityObserverKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
  readParentLineage,
} from "#execution/eve-workflow-attributes.js";
import { createLogger, logError } from "#internal/logging.js";
import { cancelRun, getHookByToken, getWorld } from "#internal/workflow/runtime.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import type { HoldingWorkflowInput } from "#execution/session/holding-workflow.js";
import { sessionDirectory } from "#execution/session/directory.js";
import { sessionEvents } from "#execution/session/events.js";
import { waitForTurnReceipt } from "#execution/turn/admission.js";
import { sessionCallbackToTurnCaller } from "#channel/session.js";
import type { ActivityCollectorInput } from "#execution/activity-collector.js";
import { createEveActivityRoutePath } from "#protocol/routes.js";
import {
  createWorkflowCallbackUrl,
  resolveWorkflowCallbackBaseUrl,
} from "#execution/workflow-callback-url.js";
import { walkCauseChain } from "#shared/errors.js";
import { buildInvocationAttributes } from "#internal/invocation/metadata.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { initializeSessionInstrumentation } from "#instrumentation/runtime.js";
const DEFAULT_ACTIVITY_COLLECTOR_RETENTION_MS = 24 * 60 * 60 * 1_000;

const log = createLogger("execution.workflow-runtime");

/**
 * Creates a runtime that resolves immutable session resources at ingress
 * and dispatches independent turns with small, accepted submissions.
 */
export function createWorkflowRuntime(config: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly nodeId?: string;
}): Runtime {
  return {
    async createSession(input: RunInput): Promise<RunHandle> {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: config.compiledArtifactsSource,
        nodeId: config.nodeId,
      });
      const ctx = buildRunContext({
        bundle,
        dynamicSubagentAgentConfig: config.dynamicSubagentAgentConfig,
        run: input,
      });
      const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
      initializeSessionInstrumentation({
        agentName: effectiveAgent.turnAgent.id,
        ctx,
        parentTraceContext: input.parentTraceContext,
      });
      const sessionTimeoutMs = effectiveAgent.limits?.sessionTimeoutMs;
      let collectorRunId: string | undefined;
      let activityObserver = input.activityObserver;
      if (
        input.parent === undefined &&
        activityObserver === undefined &&
        (getChannelActivityPresentation(input.adapter)?.renderers.length ?? 0) > 0
      ) {
        const collectorContext = serializeContext(ctx);
        const token = randomBytes(32).toString("base64url");
        const collectorInput: ActivityCollectorInput = {
          expiresAt: new Date(
            Date.now() +
              (typeof sessionTimeoutMs === "number"
                ? sessionTimeoutMs
                : DEFAULT_ACTIVITY_COLLECTOR_RETENTION_MS),
          ).toISOString(),
          serializedContext: collectorContext,
          token,
        };
        try {
          const collector = await startWorkflowOnCurrentDeployment(
            activityCollectorWorkflowReference,
            [collectorInput],
          );
          collectorRunId = collector.runId;
          const fallbackOrigin = process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : "http://localhost:3000";
          const baseUrl = resolveWorkflowCallbackBaseUrl(fallbackOrigin);
          activityObserver = {
            sink: {
              url: createWorkflowCallbackUrl(baseUrl, createEveActivityRoutePath(token)),
              version: 1,
            },
          };
          ctx.set(ActivityObserverKey, activityObserver);
        } catch {
          await cancelActivityCollector(collectorRunId);
          collectorRunId = undefined;
          log.warn("failed to start activity collector");
        }
      }
      const serializedContext = serializeContext(ctx);
      const parentLineage = readParentLineage(serializedContext);
      const command: Extract<SessionCommand, { kind: "send" }> =
        input.continuationConflictCommand ?? {
          kind: "send",
          auth: input.auth,
          caller: sessionCallbackToTurnCaller(input.callback, activityObserver),
          payload: input.input,
          delivery: input.delivery,
          requestId: input.requestId,
        };
      const workflowInput: HoldingWorkflowInput = {
        initialToken: input.continuationToken,
        firstTurn: {
          ...acceptSubmission(
            command,
            input.continuationToken && input.continuationConflictCommand === undefined
              ? `create:${createHash("sha256").update(input.continuationToken).digest("hex")}`
              : undefined,
          ),
          initial: {
            serializedContext,
            limits: input.limits,
            taskId: input.taskId ?? input.callback?.taskId,
            activityCollectorRunId: collectorRunId,
            sessionTimeoutMs,
          },
        },
      };
      const sessionAttributes =
        parentLineage.sessionId === undefined
          ? buildSessionAttributes({
              inputMessage: input.title ?? input.input.message,
              serializedContext,
            })
          : buildSubagentRootAttributes({
              identity: { nodeId: bundle.nodeId ?? ROOT_RUNTIME_AGENT_NODE_ID },
              parentCallId: parentLineage.callId,
              parentSessionId: parentLineage.sessionId,
              parentTurnId: parentLineage.turnId,
              rootSessionId: parentLineage.rootSessionId ?? parentLineage.sessionId,
              serializedContext,
            });
      const attributes = {
        ...sessionAttributes,
        ...(input.externalInvocation === undefined
          ? {}
          : buildInvocationAttributes(input.externalInvocation)),
      };

      let run: Awaited<ReturnType<typeof startWorkflowOnCurrentDeployment>>;
      try {
        run = await startWorkflowOnCurrentDeployment(holdingWorkflowReference, [workflowInput], {
          allowReservedAttributes: true,
          attributes: normalizeEveAttributes(attributes),
        });
      } catch (error) {
        await cancelActivityCollector(collectorRunId);
        logError(log, "failed to start workflow run", error, {
          continuationToken: input.continuationToken,
        });
        throw error;
      }

      const session = await sessionDirectory.resolveHolder(run.runId);
      let events: ReadableStream<MessageStreamEvent> | undefined;
      return {
        get events() {
          events ??= sessionEvents.read(session.events);
          return events;
        },
        sessionId: session.sessionId,
      };
    },

    async dispatchContinuation<TCommand extends SessionCommand>(
      input: DispatchContinuationInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await dispatchPublicCommand(input.command, () =>
        dispatchSessionCommandByToken(input.continuationToken, input.command),
      );
    },

    async dispatchSession<TCommand extends SessionCommand>(
      input: DispatchSessionInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await dispatchPublicCommand(input.command, () =>
        dispatchSessionCommand(input.sessionId, input.command),
      );
    },

    async getEventStream(
      sessionId: string,
      options?: GetEventStreamOptions,
    ): Promise<ReadableStream<MessageStreamEvent>> {
      const session = await sessionDirectory.resolveSession(sessionId);
      return sessionEvents.read(session.events, options);
    },

    async getStreamTailIndex(sessionId: string): Promise<number> {
      const session = await sessionDirectory.resolveSession(sessionId);
      return await sessionEvents.tailIndex(session.events);
    },

    async resolveContinuation(
      continuationToken: string,
    ): Promise<{ sessionId: string } | undefined> {
      try {
        const hook = await getHookByToken(continuationToken);
        const session = await sessionDirectory.resolveHolder(hook.runId);
        return { sessionId: session.sessionId };
      } catch (error) {
        if (HookNotFoundError.is(error)) {
          return undefined;
        }
        logError(log, "failed to resolve session by continuation token", error);
        throw error;
      }
    },
  };
}

async function cancelActivityCollector(runId: string | undefined): Promise<void> {
  if (runId === undefined) return;
  try {
    await cancelRun(await getWorld(), runId, {
      cancelReason: "Root session creation did not complete",
    });
  } catch {
    log.warn("failed to cancel unowned activity collector");
  }
}

async function dispatchPublicCommand<TCommand extends SessionCommand>(
  command: TCommand,
  dispatch: () => Promise<DispatchedSubmission>,
): Promise<SessionCommandResult<TCommand>> {
  try {
    const { eventId, sessionId, run } = await dispatch();
    if (command.kind === "reset" || command.kind === "cancel") {
      const receipt = await waitForTurnReceipt(run.runId);
      if (receipt.terminal && receipt.deliveries[eventId] !== "applied")
        return inactiveCommandResult(command);
    }
    return activeCommandResult(command, sessionId);
  } catch (error) {
    if (isInactiveCommandTarget(error)) return inactiveCommandResult(command);
    logError(log, "failed to dispatch session command", error, { command: command.kind });
    throw error;
  }
}

function activeCommandResult<TCommand extends SessionCommand>(
  command: TCommand,
  sessionId: string,
): SessionCommandResult<TCommand> {
  const result =
    command.kind === "reset"
      ? { previousSessionId: sessionId, status: "reset" as const }
      : command.kind === "cancel"
        ? { sessionId, status: "accepted" as const }
        : { sessionId, status: "accepted" as const };
  return result as SessionCommandResult<TCommand>;
}

function inactiveCommandResult<TCommand extends SessionCommand>(
  command: TCommand,
): SessionCommandResult<TCommand> {
  const result =
    command.kind === "send"
      ? { status: "session_not_active" as const }
      : command.kind === "cancel"
        ? { status: "no_active_turn" as const }
        : { status: "no_active_session" as const };
  return result as SessionCommandResult<TCommand>;
}

/** Returns after the cancellation candidate and its active owner have settled. */
export async function requestWorkflowTurnCancellation(
  input: CancelTurnInput,
): Promise<CancelTurnResult> {
  const command: { kind: "cancel"; taskId?: string; turnId?: string } = {
    kind: "cancel",
  };
  if (input.taskId !== undefined) command.taskId = input.taskId;
  if (input.turnId !== undefined) command.turnId = input.turnId;
  return await dispatchPublicCommand(command, () =>
    dispatchSessionCommand(input.sessionId, command),
  );
}

function isInactiveCommandTarget(error: unknown): boolean {
  if (HookNotFoundError.is(error)) return true;
  for (const candidate of walkCauseChain(error)) {
    if (
      WorkflowRunNotFoundError.is(candidate) ||
      RunExpiredError.is(candidate) ||
      EntityConflictError.is(candidate)
    ) {
      return true;
    }
  }
  return false;
}
