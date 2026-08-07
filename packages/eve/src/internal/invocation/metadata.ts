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

/** Stable receipt key shared by retries of the same input-response set. */
export function invocationUpdateRequestId(responses: readonly InputResponse[]): string {
  const canonical = responses
    .map((response) => ({
      optionId: response.optionId ?? null,
      requestId: response.requestId,
      text: response.text ?? null,
    }))
    .toSorted((left, right) => left.requestId.localeCompare(right.requestId));
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return `${INVOCATION_UPDATE_REQUEST_ID_PREFIX}${fingerprint}`;
}

export function buildInvocationAttributes(
  metadata: ExternalInvocationMetadata,
): Readonly<Record<string, string>> {
  return {
    [INVOCATION_OWNER_ATTRIBUTE]: metadata.ownerKey,
    [INVOCATION_TOKEN_ATTRIBUTE]: metadata.continuationToken,
  };
}
