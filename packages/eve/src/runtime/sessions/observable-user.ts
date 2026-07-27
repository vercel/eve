import type { SessionAuthContext } from "#channel/types.js";

/** User identity safe for framework-owned observability projections. */
export interface ObservableUserIdentity {
  readonly displayName?: string;
  readonly id: string;
}

/**
 * Projects authenticated user identity without exposing arbitrary auth claims
 * or attributes. Non-user principals are intentionally omitted.
 */
export function toObservableUserIdentity(
  auth: SessionAuthContext | null | undefined,
): ObservableUserIdentity | undefined {
  if (auth?.principalType !== "user" || auth.principalId.length === 0) {
    return undefined;
  }

  const displayName =
    auth.attributes.display_name ?? auth.attributes.name ?? auth.attributes.preferred_username;
  return {
    displayName:
      typeof displayName === "string" && displayName.length > 0 ? displayName : undefined,
    id: auth.principalId,
  };
}
