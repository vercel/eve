import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

/**
 * The root agent's Vercel Sandbox environment.
 *
 * @remarks
 * Exported because `eve build` prepares environments before any session exists: it captures a
 * snapshot holding the seeded skill files, and each session sandbox starts from that snapshot.
 * Pass this to `ctx.getSandbox(environment)` in a tool to get the Vercel-specific session handle
 * (e.g. `setNetworkPolicy()`).
 */
export const environment = VercelSandbox.environment();

/**
 * Agent sandbox configuration.
 *
 * @remarks
 * Pins the hosted Vercel Sandbox provider for both local development and production, so the
 * same environment runs everywhere. Running locally requires the project to be linked and
 * authenticated to Vercel.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export default defineSandbox(() => environment.open());
