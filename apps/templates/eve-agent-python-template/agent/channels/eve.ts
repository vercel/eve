import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc, type AuthFn } from "eve/channels/auth";
import { getPasswordSessionFromHeaders } from "../../apps/web/lib/password-auth";

/**
 * Admits browser requests that carry the signed session cookie the web app sets
 * after the user enters EVE_CHAT_PASSWORD. Returns null (skip) otherwise.
 */
const passwordAuth: AuthFn<Request> = async (request) => {
  if (!getPasswordSessionFromHeaders(request.headers)) {
    return null;
  }

  return {
    attributes: { name: "eve user" },
    authenticator: "password",
    issuer: "eve-nextjs-fastapi",
    principalId: "eve-user",
    principalType: "user",
    subject: "eve-user",
  };
};

// Walked in order. localDev() only admits requests under `eve dev` / `vercel dev`,
// so production traffic without a valid session cookie or OIDC token gets a 401.
export default eveChannel({
  auth: [passwordAuth, vercelOidc(), localDev()],
  uploadPolicy: "disabled",
});
