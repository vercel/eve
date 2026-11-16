import { defineSandbox } from "eve/sandbox";
import {
  createFactoryEnvironment,
  factoryInit,
} from "../../lib/github/repo-sandbox.js";

/**
 * Reviewer sandbox: an independent checkout of the factory repository.
 *
 * @remarks
 * Declared subagents share nothing with the root or each other, so the
 * reviewer gets its own checkout from the shared builders in
 * `agent/lib/github/repo-sandbox.ts` and fetches the branch under review
 * itself with `checkout_branch`. Reviewing in a separate sandbox from the
 * implementer is deliberate: the reviewer sees the pushed branch, not the
 * implementer's working state.
 */
export const environment = createFactoryEnvironment();

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await factoryInit(sandbox);
  return sandbox;
});
