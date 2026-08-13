import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";

const PRINCIPAL_A_AUTHORIZATION = "Bearer e2e-hitl-principal-a";
const PRINCIPAL_B_AUTHORIZATION = "Bearer e2e-hitl-principal-b";

function principal(principalId: string, authenticator = "e2e-hitl-bearer"): SessionAuthContext {
  return {
    attributes: {},
    authenticator,
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}

const authenticateA: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === PRINCIPAL_A_AUTHORIZATION
    ? principal("e2e-hitl-a")
    : null;

const authenticateB: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === PRINCIPAL_B_AUTHORIZATION
    ? principal("e2e-hitl-b")
    : null;

/**
 * Interactive authorizations require a user principal. Existing anonymous
 * fixture callers map to one deterministic end user; explicit A/B bearer
 * credentials take precedence for multiplayer transition coverage.
 */
const authenticateDefaultUser: AuthFn<Request> = () => principal("e2e-user", "e2e-fixture");

export default eveChannel({
  auth: [authenticateA, authenticateB, authenticateDefaultUser],
});
