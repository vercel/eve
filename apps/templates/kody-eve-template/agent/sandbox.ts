import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

/**
 * The Vercel Sandbox environment every session's sandbox is created from.
 *
 * @remarks
 * eve requires the environment as a named export so `eve build` can prepare it before any
 * session exists. There is no `prepare` callback; the build snapshots the base runtime and the
 * seeded skill files.
 */
export const environment = VercelSandbox.environment();

/**
 * Agent sandbox configuration.
 *
 * @remarks
 * Pins the hosted Vercel Sandbox provider for both local development and production, so the
 * same environment runs everywhere. Running locally requires the project to be linked and
 * authenticated to Vercel. `environment.open()` starts the persistent sandbox owned by the
 * current session; later steps resume it without rerunning this selector.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export default defineSandbox(() => environment.open());
