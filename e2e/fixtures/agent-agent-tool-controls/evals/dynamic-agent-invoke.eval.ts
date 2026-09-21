import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description: "An ordinary tool registers a researcher and delegates through the returned handle.",
  async test(t) {
    let turn = await t.send(
      "Alice selects a researcher for a short task. DYNAMIC_AGENT_REGISTRY delegate",
    );
    turn.expectOk();
    const receipt = turn.requireToolCall("discover-agents").output;
    await t.require(
      receipt,
      satisfies(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          Reflect.get(value, "status") === "working" &&
          typeof Reflect.get(value, "agentId") === "string",
        "ordinary delegation returns its working task receipt",
      ),
    );
    for (
      let attempt = 0;
      attempt < 4 && !turn.message?.includes("DYNAMIC-AGENT-CALL-COMPLETED");
      attempt++
    ) {
      const sessionId = turn.session.sessionId;
      const startIndex = turn.session.state?.streamIndex;
      if (sessionId === undefined || startIndex === undefined)
        throw new Error("Missing session stream coordinates.");
      turn = await t.target.watchTurn(sessionId, { startIndex }).result();
      turn.expectOk();
    }
    turn.messageIncludes("DYNAMIC-AGENT-CALL-COMPLETED");
    t.succeeded();
    t.noFailedActions();
  },
});
