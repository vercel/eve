import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * Exposes the native eve HTTP channel with the project’s configured authenticators.
 *
 * @remarks Vercel OIDC authenticates deployed callers; localDev supports the existing local development flow.
 */
export default eveChannel({
  auth: [vercelOidc(), localDev()],
});
