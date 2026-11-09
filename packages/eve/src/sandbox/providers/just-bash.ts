import { createJustBashSandboxProvider } from "#execution/sandbox/bindings/local.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import { defineSandboxProvider, type WithPrepareOption } from "#public/sandbox/provider.js";
import type { SandboxSession } from "#public/sandbox/index.js";

export type JustBashEnvironmentOptions = WithPrepareOption<
  JustBashSandboxCreateOptions,
  SandboxSession
>;

export const JustBashSandbox = defineSandboxProvider({
  name: "just-bash",
  environment: (options: JustBashSandboxCreateOptions) => createJustBashSandboxProvider(options),
});
