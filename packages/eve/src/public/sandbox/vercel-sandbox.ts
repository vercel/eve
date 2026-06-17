import type {
  Sandbox as SdkSandbox,
  SandboxUpdateParams,
} from "#compiled/@vercel/sandbox/index.js";

/**
 * Options accepted by `vercel(opts)`. Forwarded to Vercel
 * Sandbox creation for every fresh sandbox the framework creates
 * (template at prewarm time, session at first-time session-create).
 * Skipped on resume (`Sandbox.get`) since no create happens there.
 *
 * `networkPolicy` is deferred until after framework-owned base setup
 * for fresh templates and template-less sessions, so eve can install
 * required packages before authored bootstrap code runs. Template-backed
 * session creates receive it at creation time because the template
 * already contains the prepared base runtime.
 *
 * Framework-injected fields (`name`, `onResume`, `persistent`, `signal`)
 * are excluded: the framework owns those and overrides any
 * author-supplied values.
 *
 * `source` is honored only on the template create at prewarm time, so
 * an author-supplied snapshot, git revision, or tarball becomes the
 * base layer for the template. Framework setup, bootstrap, and seed
 * files all run on top, and the resulting
 * framework-owned snapshot is what every later session derives from,
 * so `source` is stripped from the session-create path. eve does not
 * detect external snapshot changes; to pick up a rebuilt external
 * snapshot, force a template rebuild (e.g. by changing the sandbox
 * definition so its template key changes).
 */
export type VercelSandboxCreateOptions = Omit<
  NonNullable<Parameters<typeof SdkSandbox.create>[0]>,
  "name" | "onResume" | "persistent" | "signal"
> &
  VercelSandboxInternalCreateOptions;

type VercelSandboxInternalCreateOptions = {
  readonly [key: `__${string}`]: unknown;
};

/**
 * Options accepted by the Vercel backend's `bootstrap({ use })` hook.
 * Aliases the Vercel SDK's `SandboxUpdateParams` because bootstrap
 * applies its options to the template via `sandbox.update(...)` after
 * `Sandbox.create()` and before the snapshot is captured. The Vercel
 * SDK persists `update`-d settings on the sandbox so they survive into
 * the snapshot, which becomes the seed for every later session.
 *
 * Today this is the same shape as
 * {@link VercelSandboxSessionUseOptions}; both are exposed as separate
 * named aliases so future divergence is non-breaking.
 */
export type VercelSandboxBootstrapUseOptions = SandboxUpdateParams;

/**
 * Options accepted by the Vercel backend's `onSession({ use })` hook.
 * Aliases the Vercel SDK's `SandboxUpdateParams`; passed values are
 * applied to the live session via the SDK's `update`.
 */
export type VercelSandboxSessionUseOptions = SandboxUpdateParams;
