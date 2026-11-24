import type { BuildContribution } from "#execution/durable.js";

const WORKFLOW_ENGINE = Symbol.for("eve.workflow-engine");

interface WorkflowEngineBuild extends BuildContribution {
  readonly [WORKFLOW_ENGINE]: { readonly world: string | undefined };
}

export function workflowEngineBuild(world?: string): BuildContribution {
  const build: WorkflowEngineBuild = { runs: true, [WORKFLOW_ENGINE]: Object.freeze({ world }) };
  return Object.freeze(build);
}

export const WORKFLOW_ENGINE_BUILD: BuildContribution = workflowEngineBuild();

export function isWorkflowEngineBuild(build: BuildContribution): boolean {
  return WORKFLOW_ENGINE in build;
}

export function workflowEngineWorld(build: BuildContribution | undefined): string | undefined {
  return build !== undefined && isWorkflowEngineBuild(build)
    ? (build as WorkflowEngineBuild)[WORKFLOW_ENGINE].world
    : undefined;
}
