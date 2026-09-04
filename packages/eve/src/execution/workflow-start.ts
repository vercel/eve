import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import { isAgentTraceContext } from "#tracing/agent-trace-context.js";
import {
  start,
  type Run,
  type StartOptionsWithoutDeploymentId,
  type WorkflowFunction,
  type WorkflowMetadata,
} from "#internal/workflow/runtime.js";

/** Starts a workflow on the deployment executing this call. */
export async function startWorkflowOnCurrentDeployment<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  options?: StartOptionsWithoutDeploymentId,
): Promise<Run<unknown> | Run<TResult>> {
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim() || undefined;
  return await withWorkflowStartContext(async () => {
    if (deploymentId !== undefined) {
      return await start(workflow, args, { ...options, deploymentId });
    }
    return options === undefined
      ? await start(workflow, args)
      : await start(workflow, args, options);
  });
}

export async function withWorkflowStartContext<TResult>(callback: () => Promise<TResult>) {
  // Agent parentage is reconstructed from eve's serialized trace context. Only
  // remove the ambient span marked by an agent boundary; the marker is not
  // propagated into Workflow runs, so Workflow-to-Workflow traces stay intact.
  const activeContext = context.active();
  const workflowContext = isAgentTraceContext(activeContext)
    ? trace.deleteSpan(activeContext)
    : activeContext;
  return await context.with(workflowContext, callback);
}
