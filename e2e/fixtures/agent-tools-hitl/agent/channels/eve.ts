import { eveChannel, type EveAuthFn } from "eve/channels/eve";

/** Fixture-only authentication for interactive authorization evals; the eval driver reads agent info. */
const authenticate: EveAuthFn = (request) => {
  const principalId = request.headers.get("x-eve-fixture-user") ?? "e2e-approval-responder";
  return {
    allowAgentInfo: true,
    attributes: {
      fixture: "authorized-response",
      // Lets a hitl eval change what the current caller's policies and tools see.
      flag: request.headers.get("x-eve-fixture-flag") ?? "none",
      model: request.headers.get("x-eve-fixture-model") ?? "default",
    },
    authenticator: "e2e-fixture",
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
};

export default eveChannel({ auth: authenticate });
