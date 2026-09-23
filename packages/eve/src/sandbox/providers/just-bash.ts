import { createJustBashSandboxProvider } from "#execution/sandbox/bindings/local.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export type JustBashEnvironmentOptions = JustBashSandboxCreateOptions;

export const JustBashSandbox = defineSandboxProvider<
  JustBashEnvironmentOptions,
  undefined,
  { readonly templateRootPath: string },
  { readonly generation: string; readonly rootPath: string; readonly version: 2 },
  SandboxSession
>({
  name: "just-bash",
  environment: (options) => createJustBashSandboxProvider(options),
});
