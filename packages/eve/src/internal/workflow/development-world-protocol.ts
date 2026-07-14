export const DEVELOPMENT_WORKFLOW_WORLD_ROUTE = "/eve/v1/dev/internal/workflow-world";
export const DEVELOPMENT_WORKFLOW_SECRET_ENV = "EVE_DEV_WORKFLOW_TRANSPORT_SECRET";
export const DEVELOPMENT_WORKER_APP_ROOT_ENV = "EVE_DEV_WORKER_APP_ROOT";
export const DEVELOPMENT_WORKFLOW_STREAM_ROUTE = `${DEVELOPMENT_WORKFLOW_WORLD_ROUTE}/stream`;
export const DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER = "x-eve-dev-workflow-transport";
export const DEVELOPMENT_WORKFLOW_DELIVERY_HEADER = "x-eve-dev-workflow-delivery";

export type DevelopmentWorldOperation =
  | "events.create"
  | "events.get"
  | "events.list"
  | "events.listByCorrelationId"
  | "hooks.get"
  | "hooks.getByToken"
  | "hooks.list"
  | "getDeploymentId"
  | "queue"
  | "resolveLatestDeploymentId"
  | "runs.experimentalSetAttributes"
  | "runs.get"
  | "runs.list"
  | "steps.get"
  | "steps.list"
  | "streams.close"
  | "streams.getChunks"
  | "streams.getInfo"
  | "streams.list"
  | "streams.write"
  | "streams.writeMulti";

export interface DevelopmentWorldCall {
  readonly arguments: readonly unknown[];
  readonly operation: DevelopmentWorldOperation;
}
