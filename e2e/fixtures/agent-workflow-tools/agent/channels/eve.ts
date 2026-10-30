import { eveChannel, type EveAuthFn } from "eve/channels/eve";

/** Fixture-only authentication; the eval driver reads agent info. */
const authenticate: EveAuthFn = (request) => {
  const forwarded = request.headers.get("x-eve-forwarded-principal-id");
  const principalId = forwarded ?? "workflow-e2e-user";
  return {
    allowAgentInfo: true,
    attributes: { fixture: "workflow-agent-probes" },
    authenticator: "e2e-fixture",
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
};

export default eveChannel({ auth: authenticate });
