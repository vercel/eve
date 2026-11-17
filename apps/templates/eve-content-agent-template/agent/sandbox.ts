import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

/**
 * The Vercel Sandbox environment every session sandbox is opened from.
 *
 * @remarks
 * Pins the hosted Vercel Sandbox provider for both local development and production, so the
 * same environment runs everywhere. Running locally requires the project to be linked and
 * authenticated to Vercel. eve seeds the style skills' files into the sandbox under
 * `$HOME/.agents/skills/`, where the model reads their reference files; the agent runs nothing
 * else in it.
 *
 * Exported because eve prepares the environment at build time, before a session exists. Authored
 * runtime code can also pass it to `ctx.getSandbox(environment)` to reach Vercel-specific
 * capabilities such as `setNetworkPolicy()`.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export const environment = VercelSandbox.environment();

/**
 * Agent sandbox configuration: opens the session's persistent sandbox from {@link environment}.
 */
export default defineSandbox(() => environment.open());
