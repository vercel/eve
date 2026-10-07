import { defineSandbox } from "eve/sandbox";

import extension from "../../extension.ts";
import {
  eveGhEnvironment,
  eveGhImplementation,
  type EveGhSessionContext,
} from "../../lib/eve-gh-sandbox.ts";
import { currentEveGhAuth } from "../../lib/eve-gh-auth.ts";
import { withDevboxCredentials } from "../../lib/devbox-credentials.ts";

// No template: each child must receive its own managed Git grant at creation.
export const environment = eveGhEnvironment(() =>
  withDevboxCredentials(eveGhImplementation(resolveAuth), resolveAuth),
);

export default defineSandbox(() => environment.open());

function resolveAuth(context: EveGhSessionContext) {
  const config = extension.config.eveGh;
  if (config?.enabled !== true) throw new Error("eve-gh sandbox is disabled.");
  return currentEveGhAuth(context.session.id);
}
