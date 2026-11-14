import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";
import { VercelSandbox } from "eve/sandbox/vercel";

import {
  MIRROR_DRIVE_NAME,
  MIRROR_PATH,
  MIRROR_REGION,
} from "./lib/contentful/mirror/files";
import { prefetchMirror } from "./lib/contentful/mirror/prefetch";

/**
 * Sandbox environment for the agent: Vercel Sandbox when deployed, just-bash locally.
 *
 * @remarks just-bash runs in process and has no network isolation, so keep local development to trusted input.
 */
export const environment =
  process.env.VERCEL === "1"
    ? VercelSandbox.environment({ region: MIRROR_REGION })
    : JustBashSandbox.environment({ autoInstall: false });

/**
 * Opens the session sandbox with a read-only mirror snapshot on Vercel.
 *
 * @returns The configured sandbox, falling back to an unmounted sandbox when the mirror is unavailable.
 * @remarks Hosted sandboxes deny all outbound network access, because the agent only searches mounted files there and every API request runs in the application.
 */
export default defineSandbox(async () => {
  if (process.env.VERCEL !== "1") {
    return environment.open();
  }
  try {
    const sandbox = await environment.open({
      mounts: { [MIRROR_PATH]: { drive: MIRROR_DRIVE_NAME, mode: "snapshot" } },
      networkPolicy: "deny-all",
    });
    await prefetchMirror(sandbox);
    return sandbox;
  } catch (error) {
    console.warn("contentful.mirror_unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return environment.open({ networkPolicy: "deny-all" });
  }
});
