import { defineAgent, defineDynamic } from "eve";
import { getGatewayModel } from "@/lib/shoppers/model";
import { scopeFromPrincipal } from "@/agent/lib/principal-scope";

export default defineAgent({
  build: { externalDependencies: ["@onkernel/browser-loop"] },
  defaultTools: false,
  model: defineDynamic(async (ctx) => {
    const { current, initiator } = ctx.session.auth;
    const caller = current ?? initiator;
    if (caller?.principalType !== "user") throw new Error("An authenticated user is required.");
    if (initiator && caller.principalId !== initiator.principalId) {
      throw new Error("The authenticated user does not own this conversation.");
    }
    return getGatewayModel(scopeFromPrincipal(caller));
  }),
  reasoning: "low",
  compaction: { threshold: 0.7 },
});
