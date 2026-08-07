import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";

const PRINCIPAL_A = "Bearer e2e-create-once-a";
const PRINCIPAL_B = "Bearer e2e-create-once-b";

function principal(issuer: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "e2e-create-once",
    issuer,
    principalId: "shared-principal-id",
    principalType: "user",
    subject: "shared-subject",
  };
}

const authenticateA: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === PRINCIPAL_A ? principal("issuer-a") : null;
const authenticateB: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === PRINCIPAL_B ? principal("issuer-b") : null;
const authenticateEvalDriver: AuthFn<Request> = () => principal("eval-driver");

export default eveChannel({ auth: [authenticateA, authenticateB, authenticateEvalDriver] });
