import { defineSandbox } from "eve/sandbox";
import {
  createFactoryEnvironment,
  factoryInit,
} from "../../lib/github/repo-sandbox.js";

/**
 * Implementer sandbox: a ready-to-work checkout of the factory repository.
 *
 * @remarks
 * Declared subagents share nothing with the root, so each station that needs
 * the repository authors its own sandbox from the shared builders in
 * `agent/lib/github/repo-sandbox.ts`. The clone and setup run once per
 * session, then the implementer branches, implements, verifies, and pushes
 * from here.
 */
export const environment = createFactoryEnvironment();

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await factoryInit(sandbox);
  return sandbox;
});
