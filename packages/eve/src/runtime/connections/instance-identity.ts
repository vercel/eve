import type { ConnectionProtocol } from "#shared/connection-types.js";
import { sha256Base64Url } from "#shared/digest.js";

/** Builds the opaque, reconstruction-stable identity for one resolved connection instance. */
export function createConnectionInstanceId(input: {
  readonly connectionName: string;
  readonly instanceKey?: string;
  readonly protocol: ConnectionProtocol;
  readonly sourceId: string;
  readonly url: string;
}): string {
  const digest = sha256Base64Url(
    JSON.stringify([
      input.sourceId,
      input.connectionName,
      input.protocol,
      input.url,
      input.instanceKey ?? "",
    ]),
  );
  return `connection:${digest}`;
}
