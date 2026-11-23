import type { AuthFn } from "eve/channels/auth";

import { isSameOrigin } from "./origin.ts";
import { getPasswordSessionFromHeaders } from "./password-auth.ts";
import { getAuthMode } from "./setup.ts";

/** Methods that only read; a same-origin GET carries no `Origin`. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The app's password session, for the agent's channel in agent/channels/eve.ts. The cookie is
 * `SameSite=Lax`, so a browser also sends it from other origins on the same site, such as a
 * sibling subdomain. It counts only on requests from the app's own pages: a request that changes
 * anything must carry this app's `Origin`, which browsers always send on a POST.
 */
export const passwordEveAuth: AuthFn<Request> = (request) => {
  if (getAuthMode() !== "password") return null;
  const origin = request.headers.get("origin");
  if (origin === null ? !READ_METHODS.has(request.method) : !isSameOrigin(request)) return null;
  if (!getPasswordSessionFromHeaders(request.headers)) return null;
  return {
    attributes: { name: "eve user" },
    authenticator: "password",
    issuer: "eve-computer-use-template",
    principalId: "eve-computer-use-user",
    principalType: "user",
    subject: "eve-computer-use-user",
  };
};
