import { createJustBashSandboxProvider } from "#execution/sandbox/bindings/local.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";

export type JustBashEnvironmentOptions = JustBashSandboxCreateOptions;

export const JustBashSandbox = defineSandboxProvider<JustBashEnvironmentOptions, undefined>({
  name: "just-bash",
  environment: (options) => createJustBashSandboxProvider(options),
});
