import type { SessionAuthContext } from "#channel/types.js";

/** Persist and forward identity only, never a channel's request-local permission extensions. */
export function sessionAuthFromResult(result: SessionAuthContext): SessionAuthContext {
  return {
    attributes: result.attributes,
    authenticator: result.authenticator,
    principalId: result.principalId,
    principalType: result.principalType,
    issuer: result.issuer,
    subject: result.subject,
  };
}
