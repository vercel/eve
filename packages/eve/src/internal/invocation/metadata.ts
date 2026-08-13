import { createHash } from "node:crypto";

import type { RunInput, SessionAuthContext } from "#channel/types.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
} from "#internal/invocation/attributes.js";

export { INVOCATION_OWNER_ATTRIBUTE, INVOCATION_TOKEN_ATTRIBUTE };

export type ExternalInvocationMetadata = NonNullable<RunInput["externalInvocation"]>;

/** Batch-scoped request id exposed to MCP clients for one durable pending-input event. */
export function invocationInputRequestId(pendingBatchId: string, requestId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([pendingBatchId, requestId]), "utf8")
    .digest("hex");
}

/** Fixed-width fingerprint used to bind an invocation to its initiating principal. */
export function invocationOwnerKey(auth: SessionAuthContext | null): string {
  const identity =
    auth === null
      ? ["anonymous"]
      : [
          auth.authenticator,
          auth.issuer ?? "",
          auth.principalType,
          auth.principalId,
          auth.subject ?? "",
        ];
  return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
}

export function buildInvocationAttributes(
  metadata: ExternalInvocationMetadata,
): Readonly<Record<string, string>> {
  return {
    [INVOCATION_OWNER_ATTRIBUTE]: metadata.ownerKey,
    [INVOCATION_TOKEN_ATTRIBUTE]: metadata.continuationToken,
  };
}
