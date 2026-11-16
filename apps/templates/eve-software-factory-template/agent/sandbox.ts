import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import {
  FACTORY_SANDBOX_CREATE_OPTIONS,
  factoryInit,
  factoryOpenOptions,
} from "./lib/github/repo-sandbox.js";

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
  const sandbox = await environment.open(factoryOpenOptions());
  await factoryInit(sandbox);
  return sandbox;
});
