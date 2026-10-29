import type { VercelSandboxSession } from "#public/sandbox/vercel.js";
import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";
import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import {
  defineSandboxProvider,
  type SandboxProvider,
  type WithPrepareOption,
} from "#public/sandbox/provider.js";
import type {
  VercelSandboxCreateOptions,
  VercelSandboxRuntimeOptions,
} from "#public/sandbox/vercel-sandbox.js";

/** Vercel create options plus `prepare`, which receives a {@link VercelSandboxSession}. */
export type VercelSandboxEnvironmentOptions = WithPrepareOption<
  VercelSandboxCreateOptions,
  VercelSandboxSession
>;
export type { VercelSandboxRuntimeOptions } from "#public/sandbox/vercel-sandbox.js";

// `| undefined` keeps the options one optional argument: the create options
// are a union that would otherwise spread into one signature per member.
export const VercelSandbox: SandboxProvider<
  VercelSandboxEnvironmentOptions | undefined,
  VercelSandboxRuntimeOptions,
  VercelSandboxSession
> = defineSandboxProvider({
  name: "vercel",
  // eve's create options mirror the SDK's; the cast drops only eve's `readonly` network policy.
  environment: (options: VercelSandboxCreateOptions) =>
    createVercelSandbox({ createOptions: options as VercelCreateOptions }),
});
