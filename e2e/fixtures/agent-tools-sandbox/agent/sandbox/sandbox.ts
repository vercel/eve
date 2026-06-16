import { defaultBackend, defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

/**
 * Sandbox lifecycle fixture exercising the surfaces an agent author relies
 * on. The matching evals live under `evals/sandbox/` and assert each piece
 * end-to-end through a real backend.
 *
 * - `bootstrap` runs once per sandbox template. It writes a known marker
 *   file into the workspace AND installs a custom CLI (`eve-greet`) onto the
 *   PATH, the way an author would provision tooling every later session
 *   inherits. The CLI is a Python script, so it also proves the base image's
 *   real Python runtime executes bootstrap-authored code.
 * - `onSession` runs once per live session. It writes a per-session marker
 *   so an eval can prove session-scoped setup ran on top of the shared
 *   template.
 *
 * Backend is left as the framework default so this fixture works both
 * locally (where `defaultBackend()` resolves to `docker()`) and on Vercel
 * deployments (where it resolves to `vercel()`). Both run the published
 * `ghcr.io/vercel/eve:latest` base image, which ships Python, Node, and git;
 * the bootstrap below assumes that real-binary environment and is not meant
 * to run against the dependency-free `just-bash` fallback.
 *
 * `EVE_TEST_AUTHOR_SNAPSHOT_ID`, when set, overrides the backend with
 * `vercel({ source: { type: "snapshot", snapshotId } })` so the
 * sandbox-author-snapshot smoke test can verify that an author-supplied
 * snapshot is honored as the template base layer while bootstrap still
 * runs on top.
 */
export const SANDBOX_MARKER_PATH = "/workspace/smoke-marker.txt";
export const SANDBOX_MARKER_TOKEN = "sandbox-bootstrap-ok-J3Q";

/**
 * Custom CLI installed during bootstrap. `/usr/local/bin` is on the default
 * PATH in the base image and is writable by the sandbox user (it is the npm
 * global prefix bin, chowned to `vercel-sandbox`), so the same install works
 * whether bootstrap runs as root (Docker) or as `vercel-sandbox` (Vercel).
 */
export const SANDBOX_CLI_PATH = "/usr/local/bin/eve-greet";
export const SANDBOX_CLI_TOKEN = "eve-greet-cli-ok-R7M";

/** Per-session marker written by `onSession` (live session, not the template). */
export const SANDBOX_SESSION_MARKER_PATH = "/workspace/session-marker.txt";
export const SANDBOX_SESSION_MARKER_TOKEN = "sandbox-onsession-ok-X5T";

const CLI_SCRIPT = [
  "#!/usr/bin/env python3",
  "import sys",
  'name = sys.argv[1] if len(sys.argv) > 1 else "world"',
  `print(f"${SANDBOX_CLI_TOKEN}:{name}")`,
  "",
].join("\n");

const authorSnapshotId = process.env.EVE_TEST_AUTHOR_SNAPSHOT_ID;
const backend =
  authorSnapshotId !== undefined
    ? vercel({ source: { snapshotId: authorSnapshotId, type: "snapshot" } })
    : defaultBackend();

export default defineSandbox({
  backend,
  // Bump when the bootstrap output changes so the reusable template snapshot
  // is rebuilt rather than served stale.
  revalidationKey: () => "agent-tools-sandbox-bootstrap-v2",
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.writeTextFile({
      path: SANDBOX_MARKER_PATH,
      content: SANDBOX_MARKER_TOKEN,
    });
    // Install a custom CLI onto the PATH and make it executable. Later
    // sessions inherit it from the template without re-running bootstrap.
    await sandbox.writeTextFile({ path: SANDBOX_CLI_PATH, content: CLI_SCRIPT });
    const chmod = await sandbox.run({ command: `chmod +x ${SANDBOX_CLI_PATH}` });
    if (chmod.exitCode !== 0) {
      throw new Error(`bootstrap: chmod of ${SANDBOX_CLI_PATH} failed: ${chmod.stderr}`);
    }
  },
  async onSession({ use }) {
    const sandbox = await use();
    await sandbox.writeTextFile({
      path: SANDBOX_SESSION_MARKER_PATH,
      content: SANDBOX_SESSION_MARKER_TOKEN,
    });
  },
});
