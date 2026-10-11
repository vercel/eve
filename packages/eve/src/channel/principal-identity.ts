import type { SessionAuthContext } from "#channel/types.js";

/**
 * The fields that identify a principal, in a fixed order, for hashing into
 * invocation owner keys and tool session ids. Attributes describe a principal;
 * they do not identify it. Adding a field changes every derived hash.
 */
export function principalIdentity(auth: SessionAuthContext): readonly string[] {
  return [
    auth.authenticator,
    auth.issuer ?? "",
    auth.principalType,
    auth.principalId,
    auth.subject ?? "",
  ];
}

/** Whether `auth` is the shared principal `none()` gives every unauthenticated caller. */
export function isAnonymousPrincipal(auth: SessionAuthContext): boolean {
  return auth.principalType === "anonymous";
}
