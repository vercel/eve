import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

/**
 * The reviewer's own Vercel Sandbox environment.
 *
 * @remarks
 * Exported because `eve build` prepares environments before any session exists; its snapshot
 * holds the reviewer's own `writing-quality` skill files.
 */
export const environment = VercelSandbox.environment();

/**
 * Reviewer sandbox configuration.
 *
 * @remarks
 * A declared subagent's sandbox does not inherit from the root, and the reviewer needs one to
 * read its `writing-quality` skill's seeded reference files. It can't share the root's with
 * `defineParentSandbox()` either, since an inheriting subagent can't bring its own skill files.
 * Pins the same hosted Vercel Sandbox provider as the root so the subagent behaves identically
 * in development and production.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export default defineSandbox(() => environment.open());
