import type { NonInteractiveAuthorizationDefinition } from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

const workspaceLabelByMembership: Readonly<Record<string, string>> = {
  "membership:alice": "ALICE_WORKSPACE_LABEL_7K4M",
  "membership:bob": "BOB_WORKSPACE_LABEL_9P2R",
};

const membershipByPrincipal: Readonly<Record<string, string>> = {
  "e2e-user": "membership:alice",
  "e2e-user-2": "membership:bob",
};

// Models a provider-side workspace membership store selected by eve for the current principal.
const userGrant: NonInteractiveAuthorizationDefinition = {
  principalType: "user",
  async getToken({ principal }) {
    if (principal.type !== "user") throw new Error("A user workspace membership is required.");
    const token = membershipByPrincipal[principal.id];
    if (token === undefined) throw new Error(`No workspace membership exists for ${principal.id}.`);
    return { token };
  },
};

export default defineTool({
  description: "Reads the current caller's workspace label. Call only when explicitly requested.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const grant = await ctx.getToken(userGrant, { authKey: "workspace-label" });
    const workspaceLabel = workspaceLabelByMembership[grant.token];
    if (workspaceLabel === undefined) throw new Error("No workspace label exists for this grant.");
    return { workspaceLabel };
  },
});
