import { createHostSandboxProvider, HOST_PROVIDER_NAME } from "#execution/sandbox/bindings/host.js";
import type {
  HostSandboxEnvironmentOptions,
  HostSandboxRuntimeOptions,
} from "#public/sandbox/host-sandbox.js";
import type { SandboxSession } from "#public/sandbox/index.js";
import { defineSandboxProvider, type SandboxProvider } from "#public/sandbox/provider.js";

export type {
  HostSandboxEnvironmentOptions,
  HostSandboxRuntimeOptions,
} from "#public/sandbox/host-sandbox.js";

/**
 * Sandbox provider that connects directly to the host filesystem and shell
 * without container or VM isolation.
 */
export const HostSandbox: SandboxProvider<
  HostSandboxEnvironmentOptions | undefined,
  HostSandboxRuntimeOptions,
  SandboxSession
> = defineSandboxProvider({
  name: HOST_PROVIDER_NAME,
  environment: (options: HostSandboxEnvironmentOptions) => createHostSandboxProvider(options),
});
