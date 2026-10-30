import type { SandboxNetworkOptions } from "#shared/sandbox-network-policy.js";

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
 * `runtime` is excluded: when `image` is not supplied, eve defaults to its
 * published `vcr.vercel.com/vercel/eve/base` image, pinned to the tag the
 * installed eve release ships with or `EVE_SANDBOX_IMAGE_TAG`. Both are
 * mutually exclusive with a stock runtime.
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
export type VercelSandboxCreateOptions = SandboxNetworkOptions & {
  readonly [key: `__${string}`]: unknown;
  readonly token?: string;
  readonly teamId?: string;
  readonly projectId?: string;
  readonly fetch?: typeof fetch;
  readonly ports?: number[];
  readonly timeout?: number;
  readonly resources?: { vcpus: number };
  readonly env?: Record<string, string>;
  readonly tags?: Record<string, string>;
  readonly region?: string;
  readonly failoverRegions?: string[];
  readonly snapshotExpiration?: number;
  readonly keepLastSnapshots?: { count: number; expiration?: number; deleteEvicted?: boolean };
} & (
    | {
        image?: string;
        source?:
          | {
              type: "git";
              url: string;
              username?: never;
              password?: never;
              depth?: number;
              revision?: string;
            }
          | {
              type: "git";
              url: string;
              username: string;
              password: string;
              depth?: number;
              revision?: string;
            }
          | { type: "tarball"; url: string };
      }
    | { image?: never; source: { type: "snapshot"; snapshotId: string } }
  );

/** Access mode for a Drive mounted into a Vercel Sandbox. */
export type VercelSandboxMountMode = "read-write" | "snapshot";

/**
 * A Drive mounted at one absolute path in a Vercel Sandbox: a `Drive` from
 * `@vercel/sandbox`, mounted read-write, or a `{ drive, mode }` reference to
 * a Drive by name, such as the one `drive.snapshot()` returns.
 */
export type VercelSandboxMount =
  | { readonly name: string }
  | { readonly drive: string; readonly mode: VercelSandboxMountMode };

/** Drive mounts keyed by absolute sandbox path. */
export type VercelSandboxMounts = Readonly<Record<string, VercelSandboxMount>>;

/** Options accepted when creating one live Vercel sandbox from an environment. */
export type VercelSandboxRuntimeOptions = Omit<
  VercelSandboxCreateOptions,
  "fetch" | "image" | "projectId" | "source" | "tags" | "teamId" | "token"
> &
  SandboxNetworkOptions & { readonly mounts?: VercelSandboxMounts };
