import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { auth } from "@/lib/auth";
import { fromBetterAuth } from "@/lib/better-auth/eve";

export default eveChannel({
  auth: [
    // Authenticates the Web client with the Better Auth session defined by the app.
    ...(auth ? [fromBetterAuth(auth)] : []),
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
  ],
});
