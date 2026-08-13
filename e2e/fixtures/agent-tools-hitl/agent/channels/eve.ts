import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";

/**
 * Authored eve channel for the interactive-authorization evals. Interactive
 * authorizations are always `principalType: "user"`, and the eval driver is
 * otherwise anonymous (`local-dev` on the local world), which fails principal
 * resolution before a challenge can open. Every caller maps to one fixed end
 * user (fixture-only; do not pattern production channels off this).
 */
const authenticateDefaultUser: AuthFn<Request> = (): SessionAuthContext => ({
  attributes: {},
  authenticator: "e2e-fixture",
  issuer: "e2e",
  principalId: "e2e-user",
  principalType: "user",
  subject: "e2e-user",
});

export default eveChannel({
  auth: [authenticateDefaultUser],
});
