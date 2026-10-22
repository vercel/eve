import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

const TOKEN = "custom-provider-session-ok-P7M";

export default defineEval({
  description:
    "Sandbox: when a custom provider's resume() reports the sandbox gone, the session continues in a fresh sandbox.",
  async test(t) {
    const turn = await t.send(
      "Ask the `custom-provider` subagent with message: Alice leaves Bob a note in the workspace, " +
        "and then the sandbox host retires her machine for maintenance before Bob checks the workspace.",
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
    const left = child.requireToolCall("leave-note").output as { machine: string };
    const checked = child.requireToolCall("check-note").output as {
      machine: string;
      note: string | null;
      probe: string | null;
    };
    // The fresh sandbox has a new machine without Alice's note, and the selector ran again.
    t.check(checked.machine === left.machine, equals(false));
    t.check(checked.note, equals(null));
    t.check(checked.probe, includes(TOKEN));
  },
});
