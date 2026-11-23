import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";

import { passwordEveAuth } from "../../apps/web/lib/eve-auth";

export default eveChannel({
  auth: [
    // The web app's password session; see apps/web/lib/setup.ts. Without
    // EVE_COMPUTER_USE_PASSWORD, a deployment lets no browser in.
    passwordEveAuth,
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
  ],
});
