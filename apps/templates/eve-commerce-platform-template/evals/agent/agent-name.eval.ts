import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { agentEvalTags, requireDeliveredText } from "@/evals/agent/shared";
import { accessScopeForUser, localDeveloperUserId } from "@/lib/auth/scope";

export default defineEval({
  description: "Uses the shopper’s new agent name in an existing conversation",
  tags: [...agentEvalTags, "agent-name"],
  async test(t) {
    const { getAgentName, setAgentName } = await import("@/lib/shoppers/agent-name");
    const scope = accessScopeForUser(localDeveloperUserId);
    const previous = await getAgentName(scope);
    const session = await t.session();
    const question = "What display name do you use? Reply in a text message, not a contact card.";
    const before = await session.send(question);
    before.succeeded();
    t.check(await requireDeliveredText(t, before), includes(previous));

    const updated = previous === "Clover Cart" ? "Clover Market" : "Clover Cart";
    try {
      await setAgentName(scope, updated);
      const after = await session.send(question);
      after.succeeded();
      t.check(await requireDeliveredText(t, after), includes(updated));
    } finally {
      await setAgentName(scope, previous);
    }
  },
});
