import { runVercel, type RunVercelOptions } from "#setup/primitives/index.js";

type VercelOutputHandler = NonNullable<RunVercelOptions["onOutput"]>;

/**
 * Runs `vercel env pull --yes` inside a linked project so `.env.local`
 * picks up the latest values, including `VERCEL_OIDC_TOKEN`, for local
 * AI Gateway model calls. Safe to call repeatedly; Vercel CLI no-ops if
 * the env is already fresh.
 */
export async function runVercelEnvPull(
  projectRoot: string,
  onOutput?: VercelOutputHandler,
  signal?: AbortSignal,
): Promise<boolean> {
  return runVercel(["env", "pull", "--yes"], { cwd: projectRoot, onOutput, signal });
}
