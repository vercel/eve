import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import type {
  VercelSandboxBootstrapUseOptions,
  VercelSandboxCreateOptions,
  VercelSandboxSessionUseOptions,
} from "#public/sandbox/vercel-sandbox.js";

/**
 * Constructs the [Vercel Sandbox](https://vercel.com/docs/sandbox)
 * backend. Configuring this backend pins it unconditionally —
 * including for local development, where it creates real hosted
 * sandboxes (requires Vercel credentials).
 *
 * The optional `opts` parameter is forwarded to Vercel when eve creates
 * a template or forks a fresh session from one. On resume
 * (`Sandbox.get`), opts are not re-applied. `networkPolicy` is applied
 * after framework-owned base setup for fresh templates and
 * template-less sessions, before authored bootstrap code runs.
 *
 * `opts.source`, if supplied, is used only on the template create:
 * the author's snapshot, git revision, or tarball becomes the base
 * layer of the template. Bootstrap, seed files, and framework setup
 * still run on top, and every session forks from the resulting
 * eve-owned snapshot. `source` is stripped from session forks so the
 * framework's snapshot always wins.
 *
 * `bootstrap({ use })` applies its options to the template via
 * `sandbox.update(...)`; those settings persist into the snapshot.
 * `onSession({ use })` applies its options to the live session via the
 * SDK's `update` under the hood, overriding any overlapping field
 * from `opts`.
 */
export function vercel(
  opts?: VercelSandboxCreateOptions,
): SandboxBackend<VercelSandboxBootstrapUseOptions, VercelSandboxSessionUseOptions> {
  return createVercelSandbox({ createOptions: opts });
}
