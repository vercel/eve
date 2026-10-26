import type { AuthFn } from "eve/channels/auth";
import { defaultEveAuth, eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";
import { authenticateWorkspaceMember } from "../lib/workspace";

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
const authenticateMember: AuthFn<Request> = (request) =>
  authenticateWorkspaceMember(request.headers.get("authorization"));
const authenticateEvalDriver: AuthFn<Request> = () => principal("eval-driver");
const authenticateRetentionCheck: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === "Bearer e2e-metadata-retention"
    ? { ...principal("retention-check"), principalType: "metadata-only" }
    : null;

/** Client context entry that asks the channel to replace the turn's context with its own. */
const REPLACE_CLIENT_CONTEXT_MARKER = "e2e:replace-client-context";
const SERVER_CONTEXT_TOKEN = "serverctx-K3M8";

export default eveChannel({
  auth: [
    authenticateA,
    authenticateB,
    authenticateMember,
    authenticateRetentionCheck,
    authenticateEvalDriver,
  ],
  onMessage(ctx) {
    const auth = defaultEveAuth(ctx);
    const { clientContext } = ctx.eve;
    if (!Array.isArray(clientContext) || !clientContext.includes(REPLACE_CLIENT_CONTEXT_MARKER)) {
      return { auth };
    }
    return { auth, clientContext: [`The server context token is ${SERVER_CONTEXT_TOKEN}.`] };
  },
});
