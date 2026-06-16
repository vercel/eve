import { defaultBackend, defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

/**
 * `bootstrap` runs once per sandbox lifetime, before the first
 * `run`, and writes a known marker file into the workspace.
 * The eval then asks the model to `cat` that file via the
 * `bash` tool and asserts the token appears in the tool result.
 *
 * Backend is left as the framework default so this fixture works
 * both locally (where `defaultBackend()` resolves to `docker()`)
 * and on Vercel deployments (where it resolves to `vercel()`).
 *
 * `EVE_TEST_AUTHOR_SNAPSHOT_ID`, when set, overrides the backend with
 * `vercel({ source: { type: "snapshot", snapshotId } })` so the
 * sandbox-author-snapshot smoke test can verify that an author-supplied
 * snapshot is honored as the template base layer while bootstrap still
 * runs on top.
 */
export const SANDBOX_MARKER_PATH = "/workspace/smoke-marker.txt";
export const SANDBOX_MARKER_TOKEN = "sandbox-bootstrap-ok-J3Q";

const authorSnapshotId = process.env.EVE_TEST_AUTHOR_SNAPSHOT_ID;
const backend =
  authorSnapshotId !== undefined
    ? vercel({ source: { snapshotId: authorSnapshotId, type: "snapshot" } })
    : defaultBackend();

export default defineSandbox({
  backend,
  revalidationKey: () => "agent-tools-sandbox-bootstrap-v1",
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.writeTextFile({
      path: SANDBOX_MARKER_PATH,
      content: SANDBOX_MARKER_TOKEN,
    });
  },
});
