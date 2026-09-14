import { createVercelSandboxProvider } from "#execution/sandbox/bindings/vercel.js";
import type {
  VercelSandboxCreateOptions,
  VercelSandboxRuntimeOptions,
} from "#public/sandbox/vercel-sandbox.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";

export type VercelSandboxEnvironmentOptions = VercelSandboxCreateOptions;
export type { VercelSandboxRuntimeOptions } from "#public/sandbox/vercel-sandbox.js";

export const VercelSandbox = defineSandboxProvider<
  VercelSandboxEnvironmentOptions,
  VercelSandboxRuntimeOptions
>({
  name: "vercel",
  environment: (options) => createVercelSandboxProvider(options),
});
