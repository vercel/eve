import {
  createVercelSandbox,
  createVercelSandboxProvider,
  type VercelSandboxPreparedArtifact,
  type VercelSandboxSessionState,
} from "#execution/sandbox/bindings/vercel.js";
import type {
  VercelSandboxCreateOptions,
  VercelSandboxRuntimeOptions,
} from "#public/sandbox/vercel-sandbox.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { NetworkPolicySandboxSession, SandboxSession } from "#shared/sandbox-session.js";

export type VercelSandboxEnvironmentOptions = VercelSandboxCreateOptions & {
  readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
};
export type { VercelSandboxRuntimeOptions } from "#public/sandbox/vercel-sandbox.js";

const defaultProvider = defineSandboxProvider<
  VercelSandboxEnvironmentOptions | undefined,
  VercelSandboxRuntimeOptions,
  VercelSandboxPreparedArtifact,
  VercelSandboxSessionState,
  NetworkPolicySandboxSession
>({
  name: "vercel",
  environment: (options) => {
    const { prepare, ...createOptions } = options ?? {};
    return createVercelSandbox({ createOptions, prepare, skipEmptyPreparation: true });
  },
});

const provider = defineSandboxProvider<
  VercelSandboxEnvironmentOptions | undefined,
  VercelSandboxRuntimeOptions,
  VercelSandboxPreparedArtifact,
  VercelSandboxSessionState,
  NetworkPolicySandboxSession
>({
  name: "vercel",
  environment: (options) => createVercelSandboxProvider(options),
});

export function createDefaultVercelEnvironment(
  options?: VercelSandboxEnvironmentOptions,
): SandboxEnvironment<VercelSandboxRuntimeOptions, NetworkPolicySandboxSession> {
  return defaultProvider.environment(options);
}

export const VercelSandbox = {
  name: "vercel",
  environment(
    options?: VercelSandboxEnvironmentOptions,
  ): SandboxEnvironment<VercelSandboxRuntimeOptions, NetworkPolicySandboxSession> {
    return provider.environment(options);
  },
};
