import type { VerifiedVercelTarget } from "#setup/vercel-deployment.js";

import {
  VERCEL_PROTECTION_BYPASS_HEADER,
  VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER,
} from "./request-headers.js";

export interface DevelopmentCredentialGrant {
  readonly target: VerifiedVercelTarget;
  readonly resolveToken: () => Promise<string>;
}

export type DevelopmentCredentialGateSnapshot =
  | { readonly kind: "anonymous" }
  | { readonly kind: "vercel"; readonly target: VerifiedVercelTarget };

/** Per-client authority for resolving and emitting remote Vercel credentials. */
export interface DevelopmentCredentialGate {
  /** The origin this gate is permanently bound to. */
  readonly serverOrigin: string;
  /**
   * Installs authority after Vercel verifies the exact origin.
   * Returns a rollback that restores the prior grant if this grant is still current.
   */
  authorize(grant: DevelopmentCredentialGrant): () => void;
  /** Returns a token-free view of the current authority. */
  current(): DevelopmentCredentialGateSnapshot;
  /** Resolves headers for one request without exposing stored credential material. */
  resolveHeaders(): Promise<Readonly<Record<string, string>>>;
}

type DevelopmentCredentialGateState =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "vercel";
      readonly target: VerifiedVercelTarget;
      readonly resolveToken: () => Promise<string>;
    };

/** Creates an anonymous credential gate bound to one client origin. */
export function createDevelopmentCredentialGate(serverUrl: string): DevelopmentCredentialGate {
  const serverOrigin = new URL(serverUrl).origin;
  let state: DevelopmentCredentialGateState = { kind: "anonymous" };

  const authorize = (grant: DevelopmentCredentialGrant): (() => void) => {
    if (grant.target.origin !== serverOrigin) {
      throw new Error(
        `Verified Vercel origin ${grant.target.origin} does not match client origin ${serverOrigin}.`,
      );
    }
    const previous = state;
    const next = {
      kind: "vercel",
      target: grant.target,
      resolveToken: grant.resolveToken,
    } as const;
    state = next;
    return () => {
      if (state === next) state = previous;
    };
  };

  const current = (): DevelopmentCredentialGateSnapshot => {
    switch (state.kind) {
      case "anonymous":
        return state;
      case "vercel":
        return { kind: "vercel", target: state.target };
    }
  };

  const resolveHeaders = async (): Promise<Readonly<Record<string, string>>> => {
    const authorized = state;
    if (authorized.kind === "anonymous") return {};

    const headers: Record<string, string> = {};
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
    if (bypassSecret) headers[VERCEL_PROTECTION_BYPASS_HEADER] = bypassSecret;
    const token = (await authorized.resolveToken()).trim();
    if (token.length > 0) {
      headers.authorization = `Bearer ${token}`;
      headers[VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER] = token;
    }
    return headers;
  };

  return { authorize, current, resolveHeaders, serverOrigin };
}
