import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";

type PrewarmAppSandboxesInput = Parameters<typeof prewarmAppSandboxes>[0];

/**
 * Vercel build-time sandbox prewarm hook. Failures here are treated as
 * build failures because the same sandbox preparation would otherwise
 * break at runtime. Credential requirements belong to each provider:
 * Docker and custom templates do not implicitly require Vercel OIDC.
 *
 * Returns `true` after validating a Vercel build's template requirements,
 * `false` outside a Vercel build.
 */
export async function runVercelBuildPrewarm(input: PrewarmAppSandboxesInput): Promise<boolean> {
  if (!process.env.VERCEL?.trim()) {
    return false;
  }

  await prewarmAppSandboxes(input);
  return true;
}
