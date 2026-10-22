import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

export default defineEval({
  description:
    "Sandbox: a custom provider rejects a network policy it cannot enforce instead of weakening it.",
  async test(t) {
    const turn = await t.send(
      "Ask the `custom-provider` subagent with message: Bob would like the sandbox network " +
        "limited to example.com, and otherwise closed.",
    );
    turn.expectOk();
    const started = turn.events.find(
      (event) => event.type === "agent.started" && event.data.name === "custom-provider",
    );
    if (started?.type !== "agent.started") {
      throw new Error("The turn did not call the custom-provider subagent.");
    }
    const child = (await t.target.watchTurn(started.data.sessionId).result()).expectOk();

    t.succeeded();
    const output = child.requireToolCall("restrict-network").output as {
      allowList: string;
      denyAll: string;
    };
    t.check(output.allowList, includes("rejects allow-lists instead of weakening them"));
    t.check(output.denyAll, equals("accepted"));
  },
});
