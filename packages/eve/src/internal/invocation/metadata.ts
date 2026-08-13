import { createHash } from "node:crypto";

import type { SessionAuthContext } from "#channel/types.js";
import {
  buildInvocationAttributes,
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
} from "#internal/invocation/attributes.js";

export { buildInvocationAttributes, INVOCATION_OWNER_ATTRIBUTE, INVOCATION_TOKEN_ATTRIBUTE };

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
