import { defineSandbox } from "eve/sandbox";
import {
  createFactoryEnvironment,
  factoryInit,
  factoryOpenOptions,
} from "../../lib/github/repo-sandbox.js";

/**
 * Analyst sandbox: a ready-to-read checkout of the factory repository.
 *
 * @remarks
 * Declared subagents share nothing with the root, so each station that needs
 * the repository authors its own sandbox from the shared builders in
 * `agent/lib/github/repo-sandbox.ts`. The clone and setup run once per
 * session. The analyst only reads; its instructions forbid modification.
 */
export const environment = createFactoryEnvironment();

export default defineSandbox(async () => {
  const sandbox = await environment.open(factoryOpenOptions());
  await factoryInit(sandbox);
  return sandbox;
});
