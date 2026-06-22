import type { VerifiedVercelTarget } from "#setup/vercel-deployment.js";

import {
  type DevelopmentOidcTokenFailure,
  type DevelopmentOidcTokenResolution,
  VERCEL_PROTECTION_BYPASS_HEADER,
  VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER,
} from "./request-headers.js";

export interface DevelopmentCredentialGrant {
  readonly target: VerifiedVercelTarget;
  readonly resolveToken: () => Promise<DevelopmentOidcTokenResolution>;
}

/** Per-client authority for resolving and emitting remote Vercel credentials. */
export interface DevelopmentCredentialGate {
  /** The origin this gate is permanently bound to. */
  readonly serverOrigin: string;
  /** Installs authority after Vercel verifies the exact origin. */
  authorize(grant: DevelopmentCredentialGrant): void;
  /** Resolves headers for one request. */
  resolveHeaders(): Promise<Readonly<Record<string, string>>>;
  /** Token failure from the most recent {@link resolveHeaders}, or `undefined` if it resolved one. */
  lastTokenFailure(): DevelopmentOidcTokenFailure | undefined;
}

type DevelopmentCredentialGateState =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "vercel";
      readonly resolveToken: () => Promise<DevelopmentOidcTokenResolution>;
    };

/** Creates an anonymous credential gate bound to one client origin. */
export function createDevelopmentCredentialGate(serverUrl: string): DevelopmentCredentialGate {
  const serverOrigin = new URL(serverUrl).origin;
  let state: DevelopmentCredentialGateState = { kind: "anonymous" };
  let tokenFailure: DevelopmentOidcTokenFailure | undefined;

  const authorize = (grant: DevelopmentCredentialGrant): void => {
    if (grant.target.origin !== serverOrigin) {
      throw new Error(
        `Verified Vercel origin ${grant.target.origin} does not match client origin ${serverOrigin}.`,
      );
    }
    state = {
      kind: "vercel",
      resolveToken: grant.resolveToken,
    } as const;
  };

  const resolveHeaders = async (): Promise<Readonly<Record<string, string>>> => {
    const authorized = state;
    if (authorized.kind === "anonymous") return {};

    const headers: Record<string, string> = {};
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
    if (bypassSecret) headers[VERCEL_PROTECTION_BYPASS_HEADER] = bypassSecret;

    const resolution = await authorized.resolveToken();
    tokenFailure = resolution.kind === "resolved" ? undefined : resolution;
    if (resolution.kind !== "resolved") return headers;

    const token = resolution.token.trim();
    if (token.length > 0) {
      headers.authorization = `Bearer ${token}`;
      headers[VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER] = token;
    }
    return headers;
  };

  return { authorize, resolveHeaders, serverOrigin, lastTokenFailure: () => tokenFailure };
}
