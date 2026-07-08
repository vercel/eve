import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import type {
  DeliverInput,
  GetEventStreamOptions,
  HookPayload,
  RunHandle,
  RunInput,
  Runtime,
} from "#channel/types.js";
import { serializeContext } from "#context/serialize.js";
import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
  readParentLineage,
} from "#execution/eve-workflow-attributes.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  getRun,
  resumeHook,
  start,
  type Run,
  type StartOptionsWithoutDeploymentId,
  type WorkflowFunction,
  type WorkflowMetadata,
} from "#internal/workflow/runtime.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import { RuntimeNoActiveSessionError } from "#execution/runtime-errors.js";

const WORKFLOW_ENTRY_NAME = "workflowEntry";
const TURN_WORKFLOW_NAME = "turnWorkflow";
const EVE_PACKAGE_INFO = resolveInstalledPackageInfo();

export const LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE =
  "deploymentId 'latest' requires a World that implements resolveLatestDeploymentId()";
export const LATEST_DEPLOYMENT_NO_GIT_BRANCH_MESSAGE = "Source deployment has no git branch";

/**
 * Workflow function names whose bundled id is stable across deployments
 * (no `@<pkg.version>` stamp). The bundler reads this set when emitting
 * the workflow id so cross-deployment routing — `start(ref, args, {
 * deploymentId: "latest" })` — finds the same workflow on a newer
 * deployment even when the eve version differs.
 *
 * Both halves of the contract (bundler output and runtime reference
 * template) read this single set so they cannot drift.
 */
export const STABLE_WORKFLOW_NAMES: ReadonlySet<string> = new Set([
  WORKFLOW_ENTRY_NAME,
  TURN_WORKFLOW_NAME,
]);

const STABLE_ID_BASE = EVE_PACKAGE_INFO.name;

const log = createLogger("execution.workflow-runtime");
let latestDeploymentFallbackMemoized = false;

interface WorkflowHookRecord {
  readonly runId: string;
}

/**
 * Stable workflow reference used by `start()` to locate the workflow
 * entrypoint registered by the Workflow DevKit builder. The id omits
 * the package version stamp so the long-lived driver can rotate across
 * deployments without rewriting the registry key.
 */
export const workflowEntryReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${WORKFLOW_ENTRY_NAME}`,
};

/**
 * Stable workflow reference used by the driver to dispatch per-turn
 * child workflow runs. The id omits the package version stamp so
 * `start(turnWorkflowReference, args, { deploymentId: "latest" })`
 * routes to the latest deployment's turn workflow even when the eve
 * version differs from the caller's deployment.
 */
export const turnWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${TURN_WORKFLOW_NAME}`,
};

/**
 * Creates a workflow-backed runtime whose long-lived driver owns the
 * event stream and dispatches each turn as a child workflow run.
 */
export function createWorkflowRuntime(config: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}): Runtime {
  return {
    async run(input: RunInput): Promise<RunHandle> {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: config.compiledArtifactsSource,
        nodeId: config.nodeId,
      });
      const ctx = buildRunContext({ bundle, run: input });
      const serializedContext = serializeContext(ctx);
      const parentLineage = readParentLineage(serializedContext);
      const attributes =
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

      let run: Awaited<ReturnType<typeof startWorkflowPreferLatest>>;
      try {
        run = await startWorkflowPreferLatest(
          workflowEntryReference,
          [
            {
              input: input.input,
              limits: input.limits,
              serializedContext,
            },
          ],
          {
            allowReservedAttributes: true,
            attributes: normalizeEveAttributes(attributes),
          },
        );
      } catch (error) {
        logError(log, "failed to start workflow run", error, {
          continuationToken: input.continuationToken,
        });
        throw error;
      }

      let events: ReadableStream<HandleMessageStreamEvent> | undefined;
      const getEvents = () => {
        events ??= parseNdjsonStream<HandleMessageStreamEvent>(() =>
          getRun(run.runId).getReadable(),
        );
        return events;
      };

      return {
        continuationToken: input.continuationToken ?? run.runId,
        get events() {
          return getEvents();
        },
        sessionId: run.runId,
      };
    },

    async deliver(input: DeliverInput): Promise<{ sessionId: string }> {
      const hookPayload: Extract<HookPayload, { kind: "deliver" }> = {
        auth: input.auth,
        kind: "deliver",
        payloads: [input.payload],
        requestId: input.requestId,
      };
      try {
        const hook = normalizeWorkflowHook(await resumeHook(input.continuationToken, hookPayload));
        return { sessionId: hook.runId };
      } catch (error) {
        // "No hook" is the expected resume-or-start signal: normalize it to
        // the eve-owned class without logging. Anything else is a real failure.
        if (HookNotFoundError.is(error)) {
          throw new RuntimeNoActiveSessionError(input.continuationToken);
        }
        logError(log, "failed to deliver to active session", error, {
          continuationToken: input.continuationToken,
        });
        throw error;
      }
    },

    async getEventStream(
      sessionId: string,
      options?: GetEventStreamOptions,
    ): Promise<ReadableStream<HandleMessageStreamEvent>> {
      return parseNdjsonStream<HandleMessageStreamEvent>(() =>
        getRun(sessionId).getReadable({ startIndex: options?.startIndex }),
      );
    },
  };
}

/**
 * Starts a workflow on the latest deployment when the active workflow world can
 * resolve it, while preserving worlds and deployments that cannot.
 */
export async function startWorkflowPreferLatest<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  options?: StartOptionsWithoutDeploymentId,
): Promise<Run<unknown> | Run<TResult>> {
  if (latestDeploymentFallbackMemoized) {
    return await startWorkflowOnCurrentDeployment(workflow, args, options);
  }

  try {
    return await start(workflow, args, { ...options, deploymentId: "latest" });
  } catch (error) {
    if (!isLatestDeploymentFallbackError(error)) {
      throw error;
    }

    const run = await startWorkflowOnCurrentDeployment(workflow, args, options);
    latestDeploymentFallbackMemoized = true;
    return run;
  }
}

/**
 * Clears the latest-routing fallback memo between tests. Production code keeps
 * the memo for the life of the process because unsupported worlds and
 * branchless deployments cannot start resolving "latest" mid-process.
 */
export function clearLatestDeploymentFallbackMemoForTest(): void {
  latestDeploymentFallbackMemoized = false;
}

async function startWorkflowOnCurrentDeployment<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  options?: StartOptionsWithoutDeploymentId,
): Promise<Run<unknown> | Run<TResult>> {
  return options === undefined ? await start(workflow, args) : await start(workflow, args, options);
}

function isLatestDeploymentFallbackError(error: unknown): boolean {
  return (
    errorMessageIncludes(error, LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE) ||
    errorMessageIncludes(error, LATEST_DEPLOYMENT_NO_GIT_BRANCH_MESSAGE)
  );
}

function errorMessageIncludes(error: unknown, message: string): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes(message)) return true;
  return error.cause !== undefined && errorMessageIncludes(error.cause, message);
}

function normalizeWorkflowHook(value: unknown): WorkflowHookRecord {
  if (value === null || typeof value !== "object" || !("runId" in value)) {
    throw new Error("Workflow hook did not include a run id.");
  }

  const runId = (value as { runId?: unknown }).runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Workflow hook did not include a run id.");
  }

  return {
    runId,
  };
}
