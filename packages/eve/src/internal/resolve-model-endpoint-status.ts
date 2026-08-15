import type { ModelRouting } from "#shared/agent-definition.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

/**
 * Presence of the two gateway credentials, read from wherever the caller can
 * observe them: the running server's `process.env` (runtime-authoritative) or
 * an app's `.env` files (dev/setup-time). Only meaningful for gateway routing.
 */
export interface GatewayCredentialPresence {
  /** `AI_GATEWAY_API_KEY` is set. */
  readonly apiKey: boolean;
  /** A Vercel OIDC token is available (`VERCEL_OIDC_TOKEN` or a linked project). */
  readonly oidc: boolean;
}

/** True when an environment value is present and non-blank. */
export function hasEnvValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/** Where a winning gateway API key was observed. */
export type GatewayCredentialSource = { kind: "env-file"; path: string } | { kind: "shell" };

/**
 * Everywhere the two gateway credentials can be observed. Callers fill in
 * whatever their vantage point can see — env files on disk, the process
 * environment, an SDK token lookup — and the resolver ranks it.
 */
export interface GatewayCredentialEvidence {
  /** `AI_GATEWAY_API_KEY` found in an app env file (the file's name). */
  readonly apiKeyFile?: string;
  /** `AI_GATEWAY_API_KEY` present in the process environment. */
  readonly apiKeyInEnv?: boolean;
  /** `VERCEL_OIDC_TOKEN` found in an app env file (the file's name). */
  readonly oidcFile?: string;
  /** An OIDC token is otherwise available (env or linked-project lookup). */
  readonly oidcAvailable?: boolean;
}

export type GatewayCredentialResolution =
  | {
      credential: "api-key";
      /** Where the winning key lives; a shell export is not eve's to remove. */
      source: GatewayCredentialSource;
      /** Present when an OIDC token exists that the key shadows. */
      shadowedOidc?: { file?: string };
    }
  | { credential: "oidc"; file?: string };

/**
 * THE one encoding of gateway credential precedence: `AI_GATEWAY_API_KEY`
 * (env file first for attribution, then the shell) outranks the OIDC token,
 * exactly as the AI SDK gateway provider resolves them. Every surface that
 * reports or ranks gateway credentials — the endpoint status, the /model
 * provider row, the link outcome, boot detection — must route through this
 * function so they can never disagree.
 */
export function resolveGatewayCredential(
  evidence: GatewayCredentialEvidence,
): GatewayCredentialResolution | undefined {
  const source: GatewayCredentialSource | undefined =
    evidence.apiKeyFile !== undefined
      ? { kind: "env-file", path: evidence.apiKeyFile }
      : evidence.apiKeyInEnv === true
        ? { kind: "shell" }
        : undefined;
  const hasOidc = evidence.oidcFile !== undefined || evidence.oidcAvailable === true;

  if (source !== undefined) {
    const resolution: GatewayCredentialResolution = { credential: "api-key", source };
    if (hasOidc) {
      resolution.shadowedOidc = evidence.oidcFile === undefined ? {} : { file: evidence.oidcFile };
    }
    return resolution;
  }
  if (hasOidc) {
    return evidence.oidcFile === undefined
      ? { credential: "oidc" }
      : { credential: "oidc", file: evidence.oidcFile };
  }
  return undefined;
}

/**
 * Composes the build-time {@link ModelRouting} with runtime credential presence
 * into the consumer-facing {@link ModelEndpointStatus}.
 *
 * Credentials matter only for gateway routing; an external endpoint makes no
 * connectedness claim. Ranking delegates to {@link resolveGatewayCredential}.
 */
export function resolveModelEndpointStatus(
  routing: ModelRouting,
  credentials: GatewayCredentialPresence,
): ModelEndpointStatus {
  if (routing.kind === "external") {
    return { kind: "external", provider: routing.provider };
  }
  const resolution = resolveGatewayCredential({
    apiKeyInEnv: credentials.apiKey,
    oidcAvailable: credentials.oidc,
  });
  if (resolution === undefined) {
    return { kind: "gateway", connected: false };
  }
  return { kind: "gateway", connected: true, credential: resolution.credential };
}
