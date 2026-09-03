import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: (request) => {
    const forwarded = request.headers.get("x-eve-forwarded-principal-id");
    const principalId = forwarded ?? "code-mode-e2e-user";
    return {
      attributes: { fixture: "code-mode" },
      authenticator: "e2e-fixture",
      issuer: "e2e",
      principalId,
      principalType: "user",
      subject: principalId,
    };
  },
});
