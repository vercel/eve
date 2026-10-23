import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// A workflow step opens the child's sandbox before the child does, and a later
// tool call of the child reads the step's note from the same sandbox.
const NOTE = "step-sandbox-note-ok-H3R:prepared-in-step";

export default defineEval({
  description: "Sandbox: a workflow step shares the calling session's sandbox.",
  async test(t) {
    const turn = await t.send(
      "Ask the `step-sandbox` subagent with message: " +
        "Alice is preparing an analysis workspace. Prepare the note and read it back.",
    );
    turn.expectOk();

    t.succeeded();
    t.calledSubagent("step-sandbox", { count: 1, status: "completed" });
    t.check(turn.message, includes(NOTE));
  },
});
