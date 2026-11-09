import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * Tools reach the agent's channels with `ctx.to()`: an ordinary tool directly, a workflow tool
 * from a step that imports the channel module, and neither from a delegated session.
 */
export default defineEval({
  description: "Tools start sessions on a channel with ctx.to(), and a root copy can't.",
  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("Requires the deterministic model's hand-off script.");
    }

    for (const [mode, tool, message] of [
      ["TOOL", "hand_off", "Alice's request, handed off."],
      ["WORKFLOW", "hand_off_workflow", "Bob's request, handed off."],
    ] as const) {
      const turn = await t.send(`HANDOFF-${mode} ${crypto.randomUUID()}`);
      turn.expectOk();
      turn.calledTool(tool, { count: 1, status: "completed" });
      const reply = /HANDOFF-RESULT (\{.*\})/u.exec(turn.reply ?? "")?.[1];
      const { sessionId } = JSON.parse(reply ?? "{}") as { sessionId?: string };
      await t.require(
        sessionId,
        satisfies((value) => typeof value === "string", `${tool} returns the target session`),
      );
      const handedOff = await t.target.attach(sessionId!).watch().result();
      handedOff.succeeded();
      handedOff.event("delivery.consumed", {
        count: 1,
        data: { parts: [{ kind: "text", text: message }] },
      });
    }

    const delegated = await t.send(`HANDOFF-DELEGATED ${crypto.randomUUID()}`);
    delegated.expectOk();
    delegated.event("child.opened", { count: 1, data: { name: "agent" } });
    delegated.messageIncludes("ctx.to() isn't available in a delegated session");
  },
});
