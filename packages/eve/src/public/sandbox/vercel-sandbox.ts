import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

type VercelSandboxGitSource = {
  readonly depth?: number;
  readonly password?: string;
  readonly revision?: string;
  readonly type: "git";
  readonly url: string;
  readonly username?: string;
};

type VercelSandboxTarballSource = {
  readonly type: "tarball";
  readonly url: string;
};

type VercelSandboxSnapshotSource = {
  readonly snapshotId: string;
  readonly type: "snapshot";
};

/** Filesystem source used to initialize a Vercel Sandbox. */
export type VercelSandboxSource =
  | VercelSandboxGitSource
  | VercelSandboxTarballSource
  | VercelSandboxSnapshotSource;

/**
 * Options applied when a Vercel Sandbox session starts. These are accepted by
 * a template's `create()` and `getOrCreate()` methods.
 */
export interface VercelSandboxSessionOptions {
  /** Default environment variables inherited by sandbox commands. */
  readonly env?: Record<string, string>;
  /** Limits how many recent snapshots the provider retains. */
  readonly keepLastSnapshots?: {
    readonly count: number;
    readonly deleteEvicted?: boolean;
    readonly expiration?: number;
  };
  /** Network access granted to the sandbox. */
  readonly networkPolicy?: SandboxNetworkPolicy;
  /** Ports exposed by the sandbox. */
  readonly ports?: number[];
  /** Vercel project used for the sandbox. */
  readonly projectId?: string;
  /** Compute allocated to the sandbox. */
  readonly resources?: {
    readonly vcpus: number;
  };
  /** Default expiration applied to snapshots, in milliseconds. */
  readonly snapshotExpiration?: number;
  /** Provider tags added alongside eve's framework tags. */
  readonly tags?: Record<string, string>;
  /** Vercel team used for the sandbox. */
  readonly teamId?: string;
  /** Provider timeout in milliseconds. */
  readonly timeout?: number;
}

/**
 * Options accepted by `VercelSandbox.create()` and `VercelSandbox.template()`.
 *
 * eve owns this API. Provider authentication, durable resource names,
 * persistence, cancellation, and restoration are supplied by the framework.
 */
export type VercelSandboxCreateOptions = VercelSandboxSessionOptions &
  (
    | {
        /** Vercel Container Registry image used as the sandbox base. */
        readonly image?: string;
        /** Git repository or tarball used as the sandbox base. */
        readonly source?: Exclude<VercelSandboxSource, VercelSandboxSnapshotSource>;
      }
    | {
        readonly image?: never;
        /** Existing Vercel snapshot used as the sandbox base. */
        readonly source: VercelSandboxSnapshotSource;
      }
  );
