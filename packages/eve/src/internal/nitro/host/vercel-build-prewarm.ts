import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";

type PrewarmAppSandboxesInput = Parameters<typeof prewarmAppSandboxes>[0];

const MISSING_VERCEL_BUILD_OIDC_ERROR =
  "Cannot build deployable Vercel output because this app requires sandbox templates and " +
  "VERCEL_OIDC_TOKEN is missing. Run `vercel link` and `vercel pull`, then retry " +
  "`vercel build`. Do not deploy the generated .vercel/output.";

export async function runVercelBuildPrewarm(input: PrewarmAppSandboxesInput): Promise<boolean> {
  if (!process.env.VERCEL?.trim()) {
    return false;
  }

  if (process.env.VERCEL_OIDC_TOKEN?.trim()) {
    await prewarmAppSandboxes(input);
    return true;
  }

  await prewarmAppSandboxes({
    ...input,
    async dispatch() {
      throw new Error(MISSING_VERCEL_BUILD_OIDC_ERROR);
    },
  });
  return true;
}
