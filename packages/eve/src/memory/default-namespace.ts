import { EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV } from "#internal/application/build-output-environment.js";
import type { DeploymentScope } from "#platform/entities.js";
import type { MemoryNamespaceContext } from "#public/memory/index.js";
import { readEnv } from "#runtime-env/env.js";
import { sha256Base64Url } from "#shared/digest.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";

export function memoryNamespaceIn(
  scope: DeploymentScope | undefined,
  context: MemoryNamespaceContext,
): string {
  if (scope === undefined) {
    return JSON.stringify([
      "eve-memory-default-namespace-v1",
      "local",
      sha256Base64Url(context.appRoot),
      context.node,
      context.slot,
    ]);
  }

  const publicRoutePrefix =
    readEnv(EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV) === "1"
      ? normalizePublicRoutePrefix(readEnv(EVE_PUBLIC_ROUTE_PREFIX_ENV))
      : undefined;
  return JSON.stringify([
    "eve-memory-default-namespace-v1",
    scope.platform,
    scope.id,
    scope.environment,
    scope.variant,
    ...(publicRoutePrefix === undefined ? [] : [publicRoutePrefix]),
    context.node,
    context.slot,
  ]);
}
