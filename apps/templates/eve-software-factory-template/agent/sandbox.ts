import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { fetchRepository } from "./lib/github/git-transfer.js";
import { FACTORY_SANDBOX_CREATE_OPTIONS } from "./lib/github/repo-sandbox.js";

/**
 * Root agent sandbox configuration.
 *
 * @remarks
 * Pins the hosted Vercel Sandbox backend for both local development and production, so the
 * same environment runs everywhere. Running locally requires the project to be linked and
 * authenticated to Vercel.
 *
 * The channel's built-in credentialed checkout is disabled. Import the default
 * branch through the same isolated object transfer the stations use, so root
 * shell commands cannot inherit GitHub write credentials either.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export const environment = VercelSandbox.environment(
  FACTORY_SANDBOX_CREATE_OPTIONS
);

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  const result = await sandbox.run({
    command:
      "git config --global --add safe.directory /workspace && git config --global --add safe.directory /workspace/repo",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to mark /workspace as a safe git directory (exit ${result.exitCode}): ${String(
        result.stderr || result.stdout
      ).trim()}`
    );
  }
  await fetchRepository(sandbox);
  return sandbox;
});
