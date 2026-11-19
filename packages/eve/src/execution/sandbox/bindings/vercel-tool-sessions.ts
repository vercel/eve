import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";

export const VERCEL_TOOL_SESSION_SNAPSHOT_EXPIRATION_MS = 24 * 60 * 60 * 1000;

export function withToolSessionRetention(options: VercelCreateOptions): VercelCreateOptions {
  return {
    ...options,
    keepLastSnapshots: { count: 1 },
    snapshotExpiration: VERCEL_TOOL_SESSION_SNAPSHOT_EXPIRATION_MS,
  };
}
