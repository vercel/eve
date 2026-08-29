import { createHash } from "node:crypto";

import type { ConnectionProtocol } from "#shared/connection-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

/** Builds the opaque, reconstruction-stable identity for one resolved connection instance. */
export function createConnectionInstanceId(input: {
  readonly connectionName: string;
  readonly instanceKey?: string;
  readonly protocol: ConnectionProtocol;
  readonly sourceId: string;
  readonly url: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        input.sourceId,
        input.connectionName,
        input.protocol,
        input.url,
        input.instanceKey ?? "",
      ]),
    )
    .digest("base64url");
  return `connection:${digest}`;
}

/** Returns the cache and callback scope for one resolved connection. */
export function connectionAuthorizationScope(connection: ResolvedConnectionDefinition): string {
  return connection.instanceId ?? connection.connectionName;
}
