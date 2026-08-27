import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";
import {
  FACTORY_SANDBOX_CREATE_OPTIONS,
  factoryBootstrap,
  factoryOnSession,
  factoryRevalidationKey,
} from "#lib/github/repo-sandbox.js";

/**
 * Analyst sandbox: a ready-to-read checkout of the factory repository.
 *
 * @remarks
 * Declared subagents share nothing with the root, so each station that needs
 * the repository authors its own sandbox from the shared builders in
 * `agent/lib/github/repo-sandbox.ts`. The clone and setup run once per
 * template build; each session pays only a fetch to the current default
 * branch. The analyst only reads; its instructions forbid modification.
 */
export default defineSandbox({
  backend: vercel(FACTORY_SANDBOX_CREATE_OPTIONS),
  bootstrap: factoryBootstrap,
  onSession: factoryOnSession,
  revalidationKey: factoryRevalidationKey,
});
