import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
  EVE_DEV_SESSION_ROUTE_PATH,
  EVE_ROUTE_PREFIX,
  DEVELOPMENT_WORKFLOW_STREAM_ROUTE,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
} from "#protocol/routes.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/flow-route.js";

type HostHttpMethod = "ALL" | "GET" | "POST";

interface HostHttpRegistration {
  readonly capability: "workflow" | "development" | "schedule";
  readonly method: HostHttpMethod;
  readonly path: string;
}

export const EVE_HOST_RESERVED_NAMESPACES: ReadonlySet<string> = new Set(["dev", "hooks"]);

export const EVE_PROTOCOL_RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
  "callback",
  "connections",
  "health",
  "info",
  "session",
]);

export function isRootEveChannel(
  channel: { readonly name: string },
  ownerKind: string | undefined,
): boolean {
  return channel.name === "eve" && ownerKind !== "extension";
}

export function findReservedEveNamespaceCollision(
  urlPath: string,
  options: { readonly allowEveProtocol: boolean },
):
  | { readonly kind: "dynamic" }
  | { readonly kind: "reserved"; readonly namespace: string }
  | undefined {
  const segments = urlPath.replace(/^\/+|\/+$/g, "").split("/");
  const prefixSegments = EVE_ROUTE_PREFIX.replace(/^\/+|\/+$/g, "").split("/");
  if (
    segments.length < prefixSegments.length + 1 ||
    !prefixSegments.every((segment, index) => segments[index] === segment)
  ) {
    return undefined;
  }
  const namespace = segments[prefixSegments.length]!;
  if (namespace.startsWith(":") || namespace.includes("*") || /^\[[^\]]+\]$/.test(namespace)) {
    return { kind: "dynamic" };
  }
  if (EVE_HOST_RESERVED_NAMESPACES.has(namespace)) {
    return { kind: "reserved", namespace };
  }
  if (!options.allowEveProtocol && EVE_PROTOCOL_RESERVED_NAMESPACES.has(namespace)) {
    return { kind: "reserved", namespace };
  }
  return undefined;
}

export const HOST_HTTP_INVENTORY: readonly HostHttpRegistration[] = Object.freeze([
  { capability: "workflow", method: "ALL", path: EVE_WORKFLOW_FLOW_ROUTE_PATH },
  { capability: "development", method: "GET", path: EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH },
  {
    capability: "development",
    method: "GET",
    path: EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  },
  {
    capability: "development",
    method: "POST",
    path: EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  },
  {
    capability: "development",
    method: "POST",
    path: EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
  },
  {
    capability: "development",
    method: "POST",
    path: EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH,
  },
  { capability: "development", method: "ALL", path: DEVELOPMENT_WORKFLOW_WORLD_ROUTE },
  { capability: "development", method: "ALL", path: DEVELOPMENT_WORKFLOW_STREAM_ROUTE },
  { capability: "development", method: "POST", path: EVE_DEV_SESSION_ROUTE_PATH },
  { capability: "schedule", method: "POST", path: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN },
]);
