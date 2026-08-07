import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";

const PRINCIPAL_A = "Bearer e2e-task-operation-a";
const PRINCIPAL_B = "Bearer e2e-task-operation-b";

function principal(principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "e2e-task-fixture",
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}

const authenticateA: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === PRINCIPAL_A ? principal("operation-user-a") : null;

const authenticateB: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === PRINCIPAL_B ? principal("operation-user-b") : null;

const authenticateEvalDriver: AuthFn<Request> = () => principal("eval-driver");

export default eveChannel({ auth: [authenticateA, authenticateB, authenticateEvalDriver] });
