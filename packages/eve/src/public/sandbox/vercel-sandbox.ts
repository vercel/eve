import type * as Vercel from "#compiled/@vercel/sandbox/index.js";
import type { SandboxNetworkOptions } from "#shared/sandbox-network-policy.js";

type VercelCreateOptions = NonNullable<Parameters<typeof Vercel.Sandbox.create>[0]>;

type VercelSandboxInternalCreateOptions = {
  readonly [key: `__${string}`]: unknown;
};

type VercelSandboxAuthorCreateOptions<T> = T extends unknown
  ? Omit<T, "mounts" | "name" | "onResume" | "persistent" | "runtime" | "signal"> &
      VercelSandboxInternalCreateOptions
  : never;

/**
 * Options accepted by Vercel sandbox environment constructors. Forwarded to Vercel
 * Sandbox creation for every fresh sandbox the framework creates
 * (template during preparation, session at first creation).
 * Skipped on resume (`Sandbox.get`) since no create happens there.
 *
 * `networkPolicy` is deferred until after framework-owned base setup
 * for fresh templates and template-less sessions, so eve can install
 * required packages before authored environment preparation runs. Template-backed
 * session creates receive it at creation time because the template
 * already contains the prepared base runtime.
 *
 * Framework-injected fields (`name`, `onResume`, `persistent`, `signal`)
 * are excluded: the framework owns those and overrides any
 * author-supplied values.
 *
 * `runtime` is excluded: eve defaults to its published
 * `vcr.vercel.com/vercel/eve/base` image tagged with the installed eve version
 * or `EVE_SANDBOX_IMAGE_TAG` when `image` is not supplied. Both are mutually
 * exclusive with a stock runtime.
 *
 * `image` is honored for fresh templates and template-less sessions. A
 * snapshot `source` takes precedence because the Vercel SDK makes it mutually
 * exclusive with `image`.
 *
 * `source` is honored only on the template creation during preparation, so
 * an author-supplied snapshot, git revision, or tarball becomes the
 * base layer for the template. Framework setup, preparation, and seed
 * files all run on top, and the resulting
 * framework-owned snapshot is what every later session derives from,
 * so `source` is stripped from the session-create path. eve does not
 * detect external snapshot changes; to pick up a rebuilt external
 * snapshot, force a template rebuild (e.g. by changing the sandbox
 * definition so its template key changes).
 */
export type VercelSandboxCreateOptions = VercelSandboxAuthorCreateOptions<VercelCreateOptions>;

/** Access mode for a Drive mounted into a Vercel Sandbox. */
export type VercelSandboxMountMode = Vercel.SandboxMountMode;

/** A Drive mounted at one absolute path in a Vercel Sandbox. */
export type VercelSandboxMount = Vercel.SandboxMounts[string];

/** Drive mounts keyed by absolute sandbox path. */
export type VercelSandboxMounts = Vercel.SandboxMounts;

/** Options resolved when eve creates a fresh live session sandbox. */
export interface VercelSandboxMountOptions {
  readonly mounts?: VercelSandboxMounts;
}

/** Options accepted when creating one live Vercel sandbox from an environment. */
export type VercelSandboxRuntimeOptions = Omit<
  VercelSandboxCreateOptions,
  "fetch" | "image" | "projectId" | "source" | "tags" | "teamId" | "token"
> &
  SandboxNetworkOptions &
  VercelSandboxMountOptions;
