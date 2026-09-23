import type {
  VercelSandboxCreateOptions,
  VercelSandboxRuntimeOptions,
} from "#public/sandbox/vercel-sandbox.js";

export interface ExperimentalVercelImageEnvironmentOptions {
  readonly region?: VercelSandboxCreateOptions["region"];
}

export type ExperimentalVercelImageRuntimeOptions = Omit<
  VercelSandboxRuntimeOptions,
  "failoverRegions" | "mounts" | "region"
>;
