import { createHash } from "node:crypto";

import type { RunInput, SessionAuthContext } from "#channel/types.js";
import type { InputResponse } from "#runtime/input/types.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  INVOCATION_UPDATE_REQUEST_ID_PREFIX,
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

export function invocationUpdateFingerprint(responses: readonly InputResponse[]): {
  readonly receipt: string;
  readonly requestSet: string;
} {
  const canonical = responses
    .map((response) => ({
      optionId: response.optionId ?? null,
      requestId: response.requestId,
      text: response.text ?? null,
    }))
    .toSorted((left, right) => left.requestId.localeCompare(right.requestId));
  const requestSet = createHash("sha256")
    .update(JSON.stringify(canonical.map((response) => response.requestId)), "utf8")
    .digest("hex");
  const receipt = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return { receipt, requestSet };
}

/** Stable receipt key shared by retries against one durable pending-input batch. */
export function invocationUpdateRequestId(
  responses: readonly InputResponse[],
  pendingBatchId = "legacy",
): string {
  const { receipt, requestSet } = invocationUpdateFingerprint(responses);
  const claim = createHash("sha256")
    .update(JSON.stringify([pendingBatchId, requestSet]), "utf8")
    .digest("hex");
  return `${INVOCATION_UPDATE_REQUEST_ID_PREFIX}${claim}:${requestSet}:${receipt}`;
}

export function buildInvocationAttributes(
  metadata: ExternalInvocationMetadata,
): Readonly<Record<string, string>> {
  return {
    [INVOCATION_OWNER_ATTRIBUTE]: metadata.ownerKey,
    [INVOCATION_TOKEN_ATTRIBUTE]: metadata.continuationToken,
  };
}
