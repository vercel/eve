import type { BuildContribution } from "#execution/durable.js";

export const WORKFLOW_ENGINE_BUILD: BuildContribution = Object.freeze({ runs: true });

export function isWorkflowEngineBuild(build: BuildContribution): boolean {
  return build === WORKFLOW_ENGINE_BUILD;
}
