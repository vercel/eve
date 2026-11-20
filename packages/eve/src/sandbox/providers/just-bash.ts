import { createJustBashSandboxProvider } from "#execution/sandbox/bindings/local.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import { defineSandboxProvider, type WithPrepareOption } from "#public/sandbox/provider.js";
import type { SandboxSession } from "#public/sandbox/index.js";

/** just-bash create options plus `prepare`, which receives a {@link SandboxSession}. */
export type JustBashEnvironmentOptions = WithPrepareOption<
  JustBashSandboxCreateOptions,
  SandboxSession
>;

/**
 * Sandbox provider that gives each session a pure-JavaScript shell and virtual filesystem, with no
 * container, VM, native processes, or network isolation.
 */
export const JustBashSandbox = defineSandboxProvider({
  name: "just-bash",
  environment: (options: JustBashSandboxCreateOptions) => createJustBashSandboxProvider(options),
});
