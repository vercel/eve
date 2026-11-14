import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";
import { VercelSandbox } from "eve/sandbox/vercel";

const deployed =
  process.env.VERCEL === "1" && process.env.VERCEL_ENV !== "development";

/**
 * Sandbox environment for the agent: Vercel Sandbox when deployed, just-bash locally.
 *
 * @remarks just-bash runs in process and has no network isolation, so keep local development to trusted input.
 */
export const environment = deployed
  ? VercelSandbox.environment()
  : JustBashSandbox.environment({ autoInstall: false });

/**
 * Opens the session sandbox, denying all outbound network access when deployed.
 *
 * @returns The opened sandbox for the configured environment.
 */
export default defineSandbox(async () =>
  deployed
    ? await environment.open({ networkPolicy: "deny-all" })
    : await environment.open()
);
