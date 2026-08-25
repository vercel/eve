import type { ClientCredentialsPolicy, ClientRedirectPolicy } from "#client/types.js";

/** Client-wide fetch policy shared by all requests for one client. */
export interface ClientRequestPolicy {
  readonly credentials?: ClientCredentialsPolicy;
  readonly redirect?: ClientRedirectPolicy;
}

/** Applies client-wide fetch policy to one request. */
export function applyClientRequestPolicy(
  init: RequestInit,
  policy: ClientRequestPolicy,
): RequestInit {
  const resolved = { ...init };

  if (resolved.credentials === undefined && policy.credentials !== undefined) {
    resolved.credentials = policy.credentials;
  }

  // Redirect policy remains client-owned so credential-bearing headers cannot
  // follow a redirect that the client configuration forbids.
  if (policy.redirect !== undefined) {
    resolved.redirect = policy.redirect;
  }

  return resolved;
}
