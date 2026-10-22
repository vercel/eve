import type { VercelSandboxSession } from "#public/sandbox/vercel.js";
import {
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
import type { SandboxSession } from "#shared/sandbox-session.js";

export type VercelSandboxEnvironmentOptions = VercelSandboxCreateOptions & {
  readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
};
export type { VercelSandboxRuntimeOptions } from "#public/sandbox/vercel-sandbox.js";

const provider = defineSandboxProvider<
  VercelSandboxEnvironmentOptions | undefined,
  VercelSandboxRuntimeOptions,
  VercelSandboxPreparedArtifact,
  VercelSandboxSessionState,
  VercelSandboxSession
>({
  name: "vercel",
  environment: (options) => createVercelSandboxProvider(options),
});

export const VercelSandbox = {
  name: "vercel",
  environment(
    options?: VercelSandboxEnvironmentOptions,
  ): SandboxEnvironment<VercelSandboxRuntimeOptions, VercelSandboxSession> {
    return provider.environment(options);
  },
};
