import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";
import { VercelSandbox } from "eve/sandbox/vercel";

// `vercel env pull` writes VERCEL=1 into .env.local, so also rule out local development.
const deployed =
  process.env.VERCEL === "1" && process.env.VERCEL_ENV !== "development";

/**
 * Sandbox environment for the agent: Vercel Sandbox when deployed, just-bash locally.
 *
 * @remarks Database credentials and connections stay in the app runtime and never enter the sandbox. just-bash runs in process and has no network isolation, so keep local development to trusted input.
 */
export const environment = deployed
  ? VercelSandbox.environment()
  : JustBashSandbox.environment({ autoInstall: false });

/**
 * Opens the session sandbox, denying all outbound network access when deployed.
 *
 * @returns The opened sandbox for the configured environment.
 * @remarks bash and write_file stay enabled for scratch work, so deny-all closes the path of writing query results to a file and sending them out with curl.
 */
export default defineSandbox(() =>
  deployed
    ? environment.open({ networkPolicy: "deny-all" })
    : environment.open()
);
