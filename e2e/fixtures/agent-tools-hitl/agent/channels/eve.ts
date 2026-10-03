import { eveChannel } from "eve/channels/eve";

/** Fixture-only authentication for interactive authorization evals. */
export default eveChannel({
  auth: (request) => {
    const principalId = request.headers.get("x-eve-fixture-user") ?? "e2e-approval-responder";
    return {
      attributes: {
        fixture: "authorized-response",
        // Lets a human-input eval change what the current caller's policies and tools see.
        flag: request.headers.get("x-eve-fixture-flag") ?? "none",
        model: request.headers.get("x-eve-fixture-model") ?? "default",
      },
      authenticator: "e2e-fixture",
      issuer: "e2e",
      principalId,
      principalType: "user",
      subject: principalId,
    };
  },
});
