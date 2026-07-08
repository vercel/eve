import type {
  VercelSandboxBootstrapUseOptions,
  VercelSandboxCreateOptions,
  VercelSandboxSessionUseOptions,
} from "#public/sandbox/vercel-sandbox.js";

/**
 * Options accepted by `islo(opts)`.
 *
 * This backend is API-compatible with the Vercel sandbox options and adds
 * `apiBaseUrl` to target a specific Islo API endpoint.
 */
export type IsloSandboxCreateOptions = VercelSandboxCreateOptions & {
  /**
   * Base API URL for the Islo provider.
   *
   * Defaults to `https://api.islo.dev`.
   */
  readonly apiBaseUrl?: string;
};

/**
 * Options accepted by the Islo backend's `bootstrap({ use })` hook.
 */
export type IsloSandboxBootstrapUseOptions = VercelSandboxBootstrapUseOptions;

/**
 * Options accepted by the Islo backend's `onSession({ use })` hook.
 */
export type IsloSandboxSessionUseOptions = VercelSandboxSessionUseOptions;
