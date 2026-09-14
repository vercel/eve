import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";

import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import type {
  VercelSandboxBootstrapUseOptions,
  VercelSandboxOptions,
  VercelSandboxSessionUseOptions,
} from "#public/sandbox/vercel-sandbox.js";

/**
 * Constructs the [Vercel Sandbox](https://vercel.com/docs/sandbox)
 * backend. Configuring this backend pins it unconditionally —
 * including for local development, where it creates real hosted
 * sandboxes (requires Vercel credentials).
 *
 * The optional provider creation fields are forwarded to Vercel Sandbox creation
 * for every fresh sandbox the framework creates (template at prewarm,
 * session at first-time create). On resume (`Sandbox.get`), no create
 * happens, so opts are not re-applied. `networkPolicy` is applied after
 * framework-owned base setup for fresh templates and template-less
 * sessions, before authored bootstrap code runs.
 *
 * `opts.source`, if supplied, is used only on the template create:
 * the author's snapshot, git revision, or tarball becomes the base
 * layer of the template. Bootstrap, seed files, and framework setup
 * still run on top, and every session derives from the resulting
 * eve-owned snapshot. `source` is stripped from session creates so the
 * framework's snapshot always wins.
 *
 * `bootstrap({ use })` applies its options to the template via
 * `sandbox.update(...)`; those settings persist into the snapshot.
 * `onSession({ use })` applies its options to the live session via the
 * SDK's `update` under the hood, overriding any overlapping field
 * from `opts`. `sessionCreateOptions`, when provided, is resolved only
 * when creating a fresh live session and can attach session-specific Drives.
 */
export function vercel(
  opts?: VercelSandboxOptions,
): SandboxBackend<VercelSandboxBootstrapUseOptions, VercelSandboxSessionUseOptions> {
  const { sessionCreateOptions, ...createOptions } = opts ?? {};
  return createVercelSandbox({
    createOptions,
    resolveSessionCreateOptions: sessionCreateOptions,
  });
}
