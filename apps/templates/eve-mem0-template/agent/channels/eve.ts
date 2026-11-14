import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [
    // Lets the eve TUI and your own Vercel deployments reach the agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // Safe default: blocks anonymous browser requests in production. Replace
    // with your auth provider (Auth.js, Clerk, ...) so each user gets their own
    // memory, or use `none()` for a public demo where everyone shares memory.
    placeholderAuth(),
  ],
});
