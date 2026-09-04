import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: (request) => {
    const forwarded = request.headers.get("x-eve-forwarded-principal-id");
    const principalId = forwarded ?? "inbox-upgrade-user";
    return {
      attributes: { fixture: "inbox-upgrade" },
      authenticator: "e2e-fixture",
      issuer: "e2e",
      principalId,
      principalType: "user",
      subject: principalId,
    };
  },
});
