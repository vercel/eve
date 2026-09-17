import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: () => ({
    attributes: { fixture: "self-modification" },
    authenticator: "e2e-fixture",
    issuer: "e2e",
    principalId: "self-modification-e2e-user",
    principalType: "user",
    subject: "self-modification-e2e-user",
  }),
});
