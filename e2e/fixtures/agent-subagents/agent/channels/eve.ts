import { eveChannel } from "eve/channels/eve";

/**
 * Authored eve channel for the remote principal-forwarding eval. Two
 * deterministic principals, no injected env:
 *
 * - The `remote-loopback` hop authenticates with a fixed bearer and runs as
 *   the `router-app` service principal — the trusted forwarder.
 * - Every other caller (the local eval driver is anonymous; the Vercel one
 *   may carry ambient OIDC) falls through to a fixed `user` principal, so
 *   the parent session always has an end-user identity to forward.
 */
const ROUTER_AUTHORIZATION = "Bearer e2e-principal-forwarding-router";

export default eveChannel({
  auth: [
    (request) =>
      request.headers.get("authorization") === ROUTER_AUTHORIZATION
        ? {
            attributes: {},
            authenticator: "e2e-bearer",
            principalId: "router-app",
            principalType: "service",
          }
        : null,
    () => ({
      attributes: {},
      authenticator: "e2e-fixture",
      issuer: "e2e",
      principalId: "e2e-user",
      principalType: "user",
      subject: "e2e-user",
    }),
  ],
  trustedForwarders: (forwarder) => forwarder.principalId === "router-app",
});
