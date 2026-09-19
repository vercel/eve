import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: () => ({
    attributes: { fixture: "task-wake-policy" },
    authenticator: "e2e-fixture",
    issuer: "e2e",
    principalId: "task-wake-policy-e2e-user",
    principalType: "user",
    subject: "task-wake-policy-e2e-user",
  }),
});
