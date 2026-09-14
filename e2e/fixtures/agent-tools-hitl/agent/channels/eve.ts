import { eveChannel } from "eve/channels/eve";

/** Fixture-only authentication for interactive authorization evals. */
export default eveChannel({
  auth: (request) => {
    const principalId = request.headers.get("x-eve-fixture-user") ?? "e2e-approval-responder";
    return {
      attributes: { fixture: "authorized-response" },
      authenticator: "e2e-fixture",
      issuer: "e2e",
      principalId,
      principalType: "user",
      subject: principalId,
    };
  },
});
