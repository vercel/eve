import { defineSandbox, type SandboxSessionContext } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";
import { FACTORY_SANDBOX_CREATE_OPTIONS } from "#lib/github/repo-sandbox.js";

/**
 * Root agent sandbox configuration.
 *
 * @remarks
 * Pins the hosted Vercel Sandbox backend for both local development and production, so the
 * same environment runs everywhere. Running locally requires the project to be linked and
 * authenticated to Vercel.
 *
 * The `onSession` hook marks `/workspace` as a safe git directory before the GitHub channel's
 * built-in per-turn checkout runs there. The sandbox filesystem is owned by the builder uid,
 * not the session user, so without this git aborts every command with "detected dubious
 * ownership in repository at '/workspace'", the channel swallows the failed checkout, and the
 * turn runs with no working tree. The station sandboxes handle the same hazard for
 * `/workspace/repo` in `agent/lib/github/repo-sandbox.ts`.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export default defineSandbox({
  backend: vercel(FACTORY_SANDBOX_CREATE_OPTIONS),
  async onSession({ use }: SandboxSessionContext): Promise<void> {
    const sandbox = await use();
    const result = await sandbox.run({
      command: "git config --global --add safe.directory /workspace",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to mark /workspace as a safe git directory (exit ${result.exitCode}): ${String(
          result.stderr || result.stdout,
        ).trim()}`,
      );
    }
  },
});
