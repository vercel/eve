import { createJustBashSandboxProvider } from "#execution/sandbox/bindings/local.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import { defineSandboxProvider } from "#public/sandbox/provider.js";

export type JustBashEnvironmentOptions = JustBashSandboxCreateOptions;

export const JustBashSandbox = defineSandboxProvider({
  name: "just-bash",
  environment: (options: Omit<JustBashEnvironmentOptions, "prepare">) =>
    createJustBashSandboxProvider(options),
});
