import type { DurableEngine } from "#execution/durable.js";
import { workflowEngineBuild } from "#execution/workflow-host/build.js";
import type { AgentWorkflowWorldDefinition } from "#shared/agent-definition.js";

/** The options of {@link workflowEngine}. */
export interface WorkflowEngineOptions {
  /** The Workflow World, as in `experimental.workflow.world` of `agent.ts`. */
  readonly world?: AgentWorkflowWorldDefinition;
}

/**
 * Returns eve's Workflow engine, for the `durable` field of a platform. Use it to choose a World
 * in the platform. Without `durable`, eve runs this engine with the World from `agent.ts`.
 */
export function workflowEngine(options: WorkflowEngineOptions = {}): DurableEngine<unknown> {
  return {
    build: workflowEngineBuild(options.world),
    start() {
      throw new Error(
        "eve starts the Workflow engine from the module its build generates. Return workflowEngine() from the durable field of definePlatform(), and do not call its start() yourself.",
      );
    },
  };
}
