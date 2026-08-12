import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";

const PRINCIPAL_A_AUTHORIZATION = "Bearer e2e-hitl-principal-a";
const PRINCIPAL_B_AUTHORIZATION = "Bearer e2e-hitl-principal-b";

function principal(principalId: string): SessionAuthContext {
  return {
    attributes: { fixture: "authorized-response" },
    authenticator: "e2e-fixture",
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}

const authenticateFixtureUser: AuthFn<Request> = (request) => {
  const authorization = request.headers.get("authorization");
  if (authorization === PRINCIPAL_A_AUTHORIZATION) return principal("e2e-hitl-a");
  if (authorization === PRINCIPAL_B_AUTHORIZATION) return principal("e2e-hitl-b");
  return principal(request.headers.get("x-eve-fixture-user") ?? "e2e-approval-responder");
};

export default eveChannel({ auth: authenticateFixtureUser });
