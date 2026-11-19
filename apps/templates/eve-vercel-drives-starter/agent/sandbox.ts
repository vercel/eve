import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

import { DRIVE_NAME, DRIVE_PATH, DRIVE_REGION } from "./lib/drive";

/**
 * Sandbox environment for the agent: always Vercel Sandbox, in the Drive's region.
 */
export const environment = VercelSandbox.environment({ region: DRIVE_REGION });

/**
 * Opens the session sandbox with a read-only snapshot of the Drive at DRIVE_PATH.
 *
 * @returns The opened Vercel sandbox, falling back to an unmounted sandbox when the Drive can't be mounted.
 * @remarks A snapshot reflects the Drive when it's mounted, so files saved later appear in new sessions. A Drive that has never been written to can't be mounted as a snapshot, so a fresh project runs without `/drive` until its first upload or save. All outbound network access is denied.
 */
export default defineSandbox(async () => {
  try {
    return await environment.open({
      mounts: { [DRIVE_PATH]: { drive: DRIVE_NAME, mode: "snapshot" } },
      networkPolicy: "deny-all",
    });
  } catch (error) {
    console.warn("drive.unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return await environment.open({ networkPolicy: "deny-all" });
  }
});
