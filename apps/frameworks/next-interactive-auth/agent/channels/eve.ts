import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";
import { requiredSignIn } from "../auth/required-sign-in";

const publicReadAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "interactive-auth-example",
  principalId: "public-read",
  principalType: "anonymous",
};

const interactiveProfileAuth: AuthFn<Request> = (request) => {
  if (request.method === "GET") return publicReadAuth;

  const pathname = new URL(request.url).pathname;
  if (pathname === "/eve/v1/session" || /^\/eve\/v1\/session\/[^/]+$/.test(pathname)) {
    return requiredSignIn("eve:test-browser");
  }
  return null;
};

export default eveChannel({
  auth: interactiveProfileAuth,
});
