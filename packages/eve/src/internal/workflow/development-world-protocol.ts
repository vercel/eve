import { getWorldImport } from "@workflow/utils";

import type { AgentWorkflowWorldDefinition } from "#shared/agent-definition.js";

export const DEVELOPMENT_WORKFLOW_WORLD_ROUTE = "/eve/v1/dev/internal/workflow-world";

/**
 * Whether development serves this app's Workflow World from the CLI parent.
 * The parent's world creation and the generated worker plugin must agree on
 * this predicate: a worker wired for the parent RPC client fails every World
 * call when the parent never created a World to serve it. An explicit
 * `world: "local"` resolves to the same vendored world as an absent config,
 * so both take the parent-owned path.
 */
export function usesParentDevelopmentWorkflowWorld(
  configuredWorld: AgentWorkflowWorldDefinition | undefined,
): boolean {
  return (
    getWorldImport({ WORKFLOW_TARGET_WORLD: configuredWorld ?? "local" }) ===
    "@workflow/world-local"
  );
}
export const DEVELOPMENT_WORKFLOW_SECRET_ENV = "EVE_DEV_WORKFLOW_TRANSPORT_SECRET";
export const DEVELOPMENT_WORKER_APP_ROOT_ENV = "EVE_DEV_WORKER_APP_ROOT";
export const DEVELOPMENT_WORKFLOW_STREAM_ROUTE = `${DEVELOPMENT_WORKFLOW_WORLD_ROUTE}/stream`;
export const DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER = "x-eve-dev-workflow-transport";
export const DEVELOPMENT_WORKFLOW_DELIVERY_HEADER = "x-eve-dev-workflow-delivery";

/**
 * The single source of truth for World operations forwarded over the dev
 * RPC: the worker client generates its method forwards from this list and
 * the parent dispatches by walking the same dot-path on the real world, so
 * adapting to a vendored-world interface change is one entry here. The
 * members NOT listed are the deliberate exceptions — `streams.get` returns
 * a live stream over its own route, `createQueueHandler` runs entirely in
 * the worker, and `start`/`close` belong to the parent's lifecycle.
 */
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
