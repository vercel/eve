import type { SessionAuthContext } from "#channel/types.js";

export function principalIdentity(auth: SessionAuthContext): readonly string[] {
  return [
    auth.authenticator,
    auth.issuer ?? "",
    auth.principalType,
    auth.principalId,
    auth.subject ?? "",
  ];
}

export function isAnonymousPrincipal(auth: SessionAuthContext): boolean {
  return auth.principalType === "anonymous";
}

export const ANONYMOUS_SESSION_AUTH_CONTEXT: SessionAuthContext = {
  attributes: {},
  authenticator: "none",
  principalId: "anonymous",
  principalType: "anonymous",
};
