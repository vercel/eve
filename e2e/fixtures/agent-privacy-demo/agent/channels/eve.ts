import { eveChannel, type EveAuthFn } from "eve/channels/eve";

import { AUDIENCE_HEADER } from "../../fixture";

/**
 * Fixture-only authentication: every caller is Alice, and an eval names the conversation's
 * audience with a header, as a Slack channel would classify a DM or a public channel.
 */
const authenticate: EveAuthFn = (request) => ({
  allowAgentInfo: true,
  attributes: { audience: request.headers.get(AUDIENCE_HEADER) ?? "private" },
  authenticator: "e2e-fixture",
  issuer: "e2e",
  principalId: "alice",
  principalType: "user",
  subject: "alice",
});

export default eveChannel({
  auth: authenticate,
  audience: ({ caller }) =>
    caller.type === "principal" && caller.principal.attributes.audience === "public"
      ? "public"
      : "private",
});
