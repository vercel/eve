import type { SessionAuthContext } from "#channel/types.js";

type IdentityKey = keyof SessionAuthContext;

// `satisfies` fails to compile when SessionAuthContext gains or loses a field.
const IDENTITY_KEYS = Object.keys({
  attributes: true,
  authenticator: true,
  issuer: true,
  principalId: true,
  principalType: true,
  subject: true,
} satisfies Record<IdentityKey, true>) as IdentityKey[];

/** Persist and forward identity only, never a channel's request-local permission extensions. */
export function sessionAuthFromResult(result: SessionAuthContext): SessionAuthContext {
  const identity: Partial<Record<IdentityKey, unknown>> = {};
  for (const key of IDENTITY_KEYS) {
    if (result[key] !== undefined) identity[key] = result[key];
  }
  return identity as SessionAuthContext;
}
