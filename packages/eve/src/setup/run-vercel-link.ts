import { runVercel, type RunVercelOptions } from "#setup/primitives/index.js";

type VercelOutputHandler = NonNullable<RunVercelOptions["onOutput"]>;

/** Hard deadline for a completed-but-unclosed Vercel CLI env pull. */
export const VERCEL_ENV_PULL_TIMEOUT_MS = 30_000;

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
  return runVercel(["env", "pull", "--yes"], {
    cwd: projectRoot,
    onOutput,
    signal,
    // `env pull --yes` has no legitimate prompt. Closing stdin prevents a
    // Vercel CLI child that ignores its non-interactive flag from retaining
    // eve's TTY after it has written the environment files.
    nonInteractive: true,
    timeoutMs: VERCEL_ENV_PULL_TIMEOUT_MS,
  });
}
