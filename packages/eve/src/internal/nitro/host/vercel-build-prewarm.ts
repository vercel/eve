import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";

type PrewarmAppSandboxesInput = Parameters<typeof prewarmAppSandboxes>[0];

const VERCEL_BUILD_PREWARM_SKIPPED_WARNING =
  "[eve] WARNING: Skipped Vercel sandbox template prewarm because VERCEL_DEPLOYMENT_ID is missing. " +
  "The generated .vercel/output may reference sandbox templates that were not provisioned. " +
  'Do not deploy it with "vercel deploy --prebuilt"; use "vercel deploy" so Vercel builds from source.';

/**
 * Detects whether the current build is running inside Vercel with a
 * stable deployment identifier. Build-time sandbox prewarm runs only
 * when this returns true so dev runs and one-off builds don't try to
 * provision templates against the platform.
 */
export function shouldPrewarmVercelBuild(): boolean {
  const vercel = process.env.VERCEL?.trim();
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();

  return (
    typeof vercel === "string" &&
    vercel.length > 0 &&
    typeof deploymentId === "string" &&
    deploymentId.length > 0
  );
}

/**
 * Vercel build-time sandbox prewarm hook. Failures here are treated as
 * build failures because the same sandbox bootstrap would otherwise
 * break at runtime.
 *
 * Returns `true` when the prewarm ran, `false` when the current
 * environment is not a Vercel build.
 */
export async function runVercelBuildPrewarm(input: PrewarmAppSandboxesInput): Promise<boolean> {
  if (!shouldPrewarmVercelBuild()) {
    if (process.env.VERCEL?.trim() && !process.env.VERCEL_DEPLOYMENT_ID?.trim()) {
      console.warn(VERCEL_BUILD_PREWARM_SKIPPED_WARNING);
    }
    return false;
  }
  await prewarmAppSandboxes(input);
  return true;
}
