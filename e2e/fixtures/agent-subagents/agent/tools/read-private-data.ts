import type { NonInteractiveAuthorizationDefinition } from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

const privateDataByGrant: Readonly<Record<string, string>> = {
  "grant:alice": "ALICE_PRIVATE_DM_7K4M",
  "grant:bob": "BOB_PRIVATE_DM_9P2R",
};

const grantByPrincipal: Readonly<Record<string, string>> = {
  "e2e-user": "grant:alice",
  "e2e-user-2": "grant:bob",
};

// Models a provider-side grant store: eve selects the principal, while the
// provider returns only that principal's bearer.
const userGrant: NonInteractiveAuthorizationDefinition = {
  principalType: "user",
  async getToken({ principal }) {
    if (principal.type !== "user") throw new Error("A user grant is required.");
    const token = grantByPrincipal[principal.id];
    if (token === undefined) throw new Error(`No OAuth grant exists for ${principal.id}.`);
    return { token };
  },
};

export default defineTool({
  description:
    "Reads private data using the current caller's user-scoped grant. Call only when explicitly requested.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const grant = await ctx.getToken(userGrant, { authKey: "private-data" });
    const privateData = privateDataByGrant[grant.token];
    if (privateData === undefined) throw new Error("No private data exists for this grant.");
    return { privateData };
  },
});
