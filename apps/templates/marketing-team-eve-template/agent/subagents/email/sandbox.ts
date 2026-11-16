import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

/**
 * The Vercel Sandbox environment this subagent's sessions open.
 *
 * @remarks
 * Exported because `eve build` prepares the environment, including this agent's skill files, before
 * any session exists.
 */
export const environment = VercelSandbox.environment();

/**
 * Subagent sandbox configuration.
 *
 * @remarks
 * Subagents inherit nothing from the root agent, and an absent `sandbox.ts` falls back to the
 * framework default. This pins the hosted Vercel Sandbox provider, which is what makes each
 * skill's `references/` files readable: static `SKILL.md` instructions load without a sandbox, but
 * supporting files are materialized into one. The lead has no skills and no sandbox tools, so it
 * declares no sandbox of its own.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export default defineSandbox(() => environment.open());
