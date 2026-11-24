import type {
  DispatchSessionInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import { durableRunEnded, installedProcessEngine } from "#execution/hosts.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import { dispatchSessionCommand, sessionRuntime } from "#execution/session-runtime.js";
import { eveBuildAttributes } from "#execution/eve-workflow-attributes.js";
import {
  installFallbackWorkflowEngine,
  workflowDurable,
  fallbackWorkflowEngine,
  workflowRunStatus,
} from "#execution/workflow-host/host.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  getWorld,
  start,
  type Run,
  type StartOptionsWithoutDeploymentId,
  type WorkflowFunction,
  type WorkflowMetadata,
} from "#internal/workflow/runtime.js";
import { pinRunId } from "#internal/workflow/start-claim.js";
import { builtInHosts } from "#runtime/app.js";
import { isAgentTraceContext } from "#tracing/eve/agent-trace-context.js";

const EVE_PACKAGE_INFO = resolveInstalledPackageInfo();

export function createWorkflowRuntime(config: SessionRuntimeConfig): Runtime {
  const hosts = builtInHosts();
  installFallbackWorkflowEngine(hosts);
  return sessionRuntime(workflowDurable(), hosts, config);
}

export async function dispatchWorkflowSessionCommand<TCommand extends SessionCommand>(
  input: DispatchSessionInput<TCommand>,
): Promise<SessionCommandResult<TCommand>> {
  return await dispatchSessionCommand(workflowDurable(), input);
}

export async function hasRunEnded(runId: string): Promise<boolean> {
  return await durableRunEnded(workflowRunStatus, runId);
}

export async function startWorkflowOnCurrentDeployment<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  options?: StartOptionsWithoutDeploymentId,
): Promise<Run<unknown> | Run<TResult>> {
  return await startWorkflowOnDeployment(
    workflow,
    args,
    await resolveCurrentWorkflowDeploymentId(),
    options,
  );
}

type StartClaim = (runId: string) => { readonly token: string; readonly metadata?: unknown };

export async function startWorkflowOnDeployment<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  deploymentId: string,
  options?: StartOptionsWithoutDeploymentId,
  claim?: StartClaim,
  runId?: string,
): Promise<Run<unknown> | Run<TResult>> {
  return await withWorkflowStartContext(async () => {
    if (deploymentId.length === 0 || deploymentId === "latest") {
      throw new Error("Workflow starts require an exact deployment id.");
    }
    const startOptions = {
      ...options,
      allowReservedAttributes: true,
      attributes: { ...options?.attributes, ...eveBuildAttributes(EVE_PACKAGE_INFO.version) },
      deploymentId,
    };
    if (claim === undefined) return await start(workflow, args, startOptions);
    const pinned = pinRunId(await getWorld(), startOptions, runId);
    const run = await start(workflow, args, {
      ...startOptions,
      experimental_hook: claim(pinned.runId),
      world: pinned.world,
    });
    if (run.runId !== pinned.runId) {
      await run.cancel().catch(() => {});
      throw new Error(
        `Workflow started run "${run.runId}" instead of the pinned "${pinned.runId}", so its claimed hook names the wrong run.`,
      );
    }
    return run;
  });
}

export async function resolveCurrentWorkflowDeploymentId(): Promise<string> {
  const engine = installedProcessEngine(builtInHosts());
  const deploymentId = await (
    engine?.name === "workflow" ? engine : fallbackWorkflowEngine()
  ).deploymentId();
  if (deploymentId.length === 0 || deploymentId === "latest") {
    throw new Error("Workflow runtime could not resolve an exact deployment id.");
  }
  return deploymentId;
}

async function withWorkflowStartContext<TResult>(callback: () => Promise<TResult>) {
  const activeContext = context.active();
  const workflowContext = isAgentTraceContext(activeContext)
    ? trace.deleteSpan(activeContext)
    : activeContext;
  return await context.with(workflowContext, callback);
}
