import type { DevelopmentGenerationAvailability } from "#internal/workflow/development-runtime-compatibility.js";
import type { AgentWorkflowWorldDefinition } from "#shared/agent-definition.js";
import { resolveWorkflowWorldImport } from "#internal/workflow/world-target.js";

export function usesParentDevelopmentWorkflowWorld(
  configuredWorld: AgentWorkflowWorldDefinition | undefined,
): boolean {
  return resolveWorkflowWorldImport(configuredWorld ?? "local") === "@workflow/world-local";
}
export const DEVELOPMENT_WORKER_APP_ROOT_ENV = "EVE_DEV_WORKER_APP_ROOT";
export const DEVELOPMENT_WORKFLOW_DELIVERY_HEADER = "x-eve-dev-workflow-delivery";

export const DEVELOPMENT_WORLD_OPERATIONS = [
  "events.create",
  "events.get",
  "events.list",
  "events.listByCorrelationId",
  "hooks.get",
  "hooks.getByToken",
  "hooks.list",
  "getDeploymentId",
  "queue",
  "resolveLatestDeploymentId",
  "runs.experimentalSetAttributes",
  "runs.get",
  "runs.list",
  "steps.get",
  "steps.list",
  "streams.close",
  "streams.getChunks",
  "streams.getInfo",
  "streams.list",
  "streams.write",
  "streams.writeMulti",
] as const;

export type DevelopmentWorldOperation = (typeof DEVELOPMENT_WORLD_OPERATIONS)[number];

export interface DevelopmentWorldCall {
  readonly arguments: readonly unknown[];
  readonly operation: DevelopmentWorldOperation;
}

export type DevelopmentGenerationAdmission =
  | DevelopmentGenerationAvailability
  | { readonly kind: "dormant" };

export interface DevelopmentGenerationAvailabilityCall {
  readonly operation: "eve.getGenerationAvailability";
  readonly generationId: string;
}

export type DevelopmentWorldRequest = DevelopmentWorldCall | DevelopmentGenerationAvailabilityCall;
