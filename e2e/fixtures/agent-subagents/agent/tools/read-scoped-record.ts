import type { NonInteractiveAuthorizationDefinition } from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

const recordByGrant: Readonly<Record<string, string>> = {
  "scope:alice": "ALICE_SCOPED_RECORD_7K4M",
  "scope:bob": "BOB_SCOPED_RECORD_9P2R",
};

const grantByPrincipal: Readonly<Record<string, string>> = {
  "e2e-user": "scope:alice",
  "e2e-user-2": "scope:bob",
};

// Models a provider-side grant store: eve selects the principal, while the
// provider returns only that principal's bearer.
const userGrant: NonInteractiveAuthorizationDefinition = {
  principalType: "user",
  async getToken({ principal }) {
    if (principal.type !== "user") throw new Error("A user grant is required.");
    const token = grantByPrincipal[principal.id];
    if (token === undefined) throw new Error(`No scoped record grant exists for ${principal.id}.`);
    return { token };
  },
};

export default defineTool({
  description:
    "Reads the current caller's synthetic scoped record using its user-scoped test grant. Call only when explicitly requested.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const grant = await ctx.getToken(userGrant, { authKey: "scoped-record" });
    const record = recordByGrant[grant.token];
    if (record === undefined) throw new Error("No scoped record exists for this grant.");
    return { record };
  },
});
