import type { VerifiedVercelTarget } from "#setup/vercel-deployment.js";

import {
  type DevelopmentOidcTokenFailure,
  type DevelopmentOidcTokenResolution,
  VERCEL_PROTECTION_BYPASS_HEADER,
} from "./request-headers.js";

export interface DevelopmentCredentialGrant {
  readonly target: VerifiedVercelTarget;
  readonly resolveToken: () => Promise<DevelopmentOidcTokenResolution | string>;
}

export interface DevelopmentCredentialGate {
  readonly serverOrigin: string;
  authorize(grant: DevelopmentCredentialGrant): () => void;
  resolveToken(): Promise<string>;
  resolveBypassHeaders(): Promise<Readonly<Record<string, string>>>;
  lastTokenFailure(): DevelopmentOidcTokenFailure | undefined;
}

type DevelopmentCredentialGateState =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "vercel";
      readonly resolveToken: () => Promise<DevelopmentOidcTokenResolution | string>;
    };

export function createDevelopmentCredentialGate(serverUrl: string): DevelopmentCredentialGate {
  const serverOrigin = new URL(serverUrl).origin;
  let state: DevelopmentCredentialGateState = { kind: "anonymous" };
  let tokenFailure: DevelopmentOidcTokenFailure | undefined;

  const authorize = (grant: DevelopmentCredentialGrant): (() => void) => {
    if (grant.target.origin !== serverOrigin) {
      throw new Error(
        `Verified Vercel origin ${grant.target.origin} does not match client origin ${serverOrigin}.`,
      );
    }
    const previous = state;
    const previousTokenFailure = tokenFailure;
    const next = {
      kind: "vercel",
      resolveToken: grant.resolveToken,
    } as const;
    state = next;
    tokenFailure = undefined;
    return () => {
      if (state === next) {
        state = previous;
        tokenFailure = previousTokenFailure;
      }
    };
  };

  const resolveToken = async (): Promise<string> => {
    const authorized = state;
    if (authorized.kind === "anonymous") return "";

    const resolution = await authorized.resolveToken();
    const failure =
      typeof resolution === "string" || resolution.kind === "resolved" ? undefined : resolution;
    if (state === authorized) tokenFailure = failure;
    if (typeof resolution === "string") {
      return resolution.trim();
    }

    return resolution.kind === "resolved" ? resolution.token.trim() : "";
  };

  const resolveBypassHeaders = async (): Promise<Readonly<Record<string, string>>> => {
    const authorized = state;
    if (authorized.kind === "anonymous") return {};
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
    return bypassSecret ? { [VERCEL_PROTECTION_BYPASS_HEADER]: bypassSecret } : {};
  };

  return {
    authorize,
    lastTokenFailure: () => tokenFailure,
    resolveBypassHeaders,
    resolveToken,
    serverOrigin,
  };
}
