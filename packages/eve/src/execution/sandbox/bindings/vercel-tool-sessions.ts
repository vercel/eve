import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";

/**
 * How long a tool session's saved filesystem outlives its last use. It is
 * also the shortest `snapshotExpiration` the Sandbox API accepts.
 */
export const VERCEL_TOOL_SESSION_SNAPSHOT_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/*
 * A tool session has no end to delete its sandbox at, so Vercel expires it:
 * the sandbox's snapshots expire a day after their last use (each resume
 * restarts that day), and only the latest is kept. The next call for the key
 * then finds the snapshot gone and starts a fresh sandbox under the same
 * name. These options apply when the sandbox is created, so they do not
 * change its name.
 */
export function withToolSessionRetention(options: VercelCreateOptions): VercelCreateOptions {
  return {
    ...options,
    keepLastSnapshots: { count: 1 },
    snapshotExpiration: VERCEL_TOOL_SESSION_SNAPSHOT_EXPIRATION_MS,
  };
}
