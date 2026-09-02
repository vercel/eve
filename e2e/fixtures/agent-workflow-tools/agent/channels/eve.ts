import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: (request) => {
    const forwarded = request.headers.get("x-eve-forwarded-principal-id");
    const principalId = forwarded ?? "workflow-e2e-user";
    return {
      attributes: { fixture: "workflow-agent-probes" },
      authenticator: "e2e-fixture",
      issuer: "e2e",
      principalId,
      principalType: "user",
      subject: principalId,
    };
  },
});
