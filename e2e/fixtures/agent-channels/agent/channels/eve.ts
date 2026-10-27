import { eveChannel } from "eve/channels/eve";

// Fixture-only identities: the eval driver is an operator; Alice and Bob are separate users.
export default eveChannel({
  auth: (request) => {
    const authorization = request.headers.get("authorization");
    const issuer =
      authorization === "Bearer fixture-alice"
        ? "alice"
        : authorization === "Bearer fixture-bob"
          ? "bob"
          : undefined;
    return {
      attributes: {},
      authenticator: "fixture",
      issuer: issuer ?? "eval-driver",
      principalId: "fixture-person",
      principalType: issuer === undefined ? "service" : "user",
    };
  },
});
