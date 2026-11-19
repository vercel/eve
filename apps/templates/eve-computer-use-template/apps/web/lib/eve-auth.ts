import type { AuthFn } from "eve/channels/auth";

import { getPasswordSessionFromHeaders } from "./password-auth";
import { getAuthMode } from "./setup";

/** The app's password session, for the agent's channel in agent/channels/eve.ts. */
export const passwordEveAuth: AuthFn<Request> = (request) => {
  if (getAuthMode() !== "password" || !getPasswordSessionFromHeaders(request.headers)) return null;
  return {
    attributes: { name: "eve user" },
    authenticator: "password",
    issuer: "eve-computer-use-template",
    principalId: "eve-computer-use-user",
    principalType: "user",
    subject: "eve-computer-use-user",
  };
};
