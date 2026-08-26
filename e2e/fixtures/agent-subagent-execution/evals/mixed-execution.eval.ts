import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "One response can wait for a blocking subagent while admitting a background subagent task.",
  async test(t) {
    const turn = await t.send("SUBAGENT-MIXED-EXECUTION");

    turn.expectOk();
    turn.messageIncludes("SUBAGENT-MIXED-EXECUTION-OK");
    turn.messageIncludes("MIXED-BLOCKING-RESULT");
    turn.calledSubagent("blocking-worker", { output: /MIXED-BLOCKING-RESULT/u });
    const background = turn.events.filter(
      (event) =>
        event.type === "subagent.completed" && event.data.subagentName === "background-worker",
    );
    if (
      background.length !== 1 ||
      background[0]?.type !== "subagent.completed" ||
      background[0].data.backgroundTask?.status !== "working"
    ) {
      throw new Error("Background worker did not return exactly one working task receipt.");
    }
  },
});
