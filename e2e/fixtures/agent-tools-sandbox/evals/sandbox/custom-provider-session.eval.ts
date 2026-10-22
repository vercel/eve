import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

const TOKEN = "custom-provider-session-ok-P7M";
const WORKSPACE_ROOT = "/srv/app";
const CHECKLIST = "Bob, the checklist is ready.";

export default defineEval({
  description:
    "Sandbox: custom provider session methods survive framework lifecycle wrapping, and paths resolve from the connection's workspace root.",
  async test(t) {
    const turn = await t.send(
      "Ask the `custom-provider` subagent with message: Verify the custom provider session marker and leave Bob his checklist.",
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
    t.calledSubagent("custom-provider", { count: 1, status: "completed" });
    const verified = child.requireToolCall("verify-provider-session").output as {
      checklist: string | null;
      checklistAtRoot: string | null;
      probe: string | null;
      root: string;
    };
    // The selector's relative write and the tool's relative round trip land under the connection's root.
    t.check(verified.root, equals(WORKSPACE_ROOT));
    t.check(verified.probe, includes(TOKEN));
    t.check(verified.checklist, equals(CHECKLIST));
    t.check(verified.checklistAtRoot, equals(CHECKLIST));
  },
});
