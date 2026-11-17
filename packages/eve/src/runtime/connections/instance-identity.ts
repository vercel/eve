import { createHash } from "node:crypto";

import type { ConnectionProtocol } from "#shared/connection-types.js";

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
