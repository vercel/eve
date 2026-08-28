import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * The chat transport the browser client talks to.
 *
 * `localDev` opens it up on `eve dev`; `vercelOidc` covers deployed
 * preview and production. Add your own `AuthFn` ahead of these before
 * exposing a real storefront to real buyers.
 */
export default eveChannel({
  auth: [vercelOidc(), localDev()],
});
