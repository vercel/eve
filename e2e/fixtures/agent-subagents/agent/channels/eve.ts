import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";

/**
 * Authored eve channel for the remote principal-forwarding eval. Three
 * deterministic principals, no injected env (the deployment is deliberately
 * open — fixture-only; do not pattern production channels off this):
 *
 * - The `remote-loopback` hop authenticates with a fixed bearer and runs as
 *   the `router-app` service principal — the trusted forwarder.
 * - A second fixed bearer authenticates as a distinct end user, so the eval
 *   can continue a session as a different caller and prove the current and
 *   initiator principals cross the hop independently.
 * - Every other caller (the local eval driver is anonymous; the Vercel one
 *   may carry ambient OIDC) falls through to a fixed `user` principal, so
 *   the parent session always has an end-user identity to forward.
 */
const ROUTER_AUTHORIZATION = "Bearer e2e-principal-forwarding-router";
const SECOND_USER_AUTHORIZATION = "Bearer e2e-principal-forwarding-second-user";

function createFixtureUserPrincipal(principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "e2e-fixture",
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}

const authenticateRouter: AuthFn<Request> = (request) => {
  if (request.headers.get("authorization") !== ROUTER_AUTHORIZATION) return null;
  return {
    attributes: {},
    authenticator: "e2e-bearer",
    principalId: "router-app",
    principalType: "service",
  };
};

const authenticateSecondUser: AuthFn<Request> = (request) => {
  if (request.headers.get("authorization") !== SECOND_USER_AUTHORIZATION) return null;
  return createFixtureUserPrincipal("e2e-user-2");
};

const authenticateDefaultUser: AuthFn<Request> = () => createFixtureUserPrincipal("e2e-user");

export default eveChannel({
  auth: [authenticateRouter, authenticateSecondUser, authenticateDefaultUser],
  trustedForwarders: (forwarder) => forwarder.principalId === "router-app",
});
