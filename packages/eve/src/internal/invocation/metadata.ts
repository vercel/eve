import { createHash } from "node:crypto";

import type { RunInput, SessionAuthContext } from "#channel/types.js";

export const INVOCATION_TOKEN_ATTRIBUTE = "$eve.invocation_token";
export const INVOCATION_OWNER_ATTRIBUTE = "$eve.invocation_owner";

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

export function buildInvocationAttributes(
  metadata: ExternalInvocationMetadata,
): Readonly<Record<string, string>> {
  return {
    [INVOCATION_OWNER_ATTRIBUTE]: metadata.ownerKey,
    [INVOCATION_TOKEN_ATTRIBUTE]: metadata.continuationToken,
  };
}
