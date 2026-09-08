import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description:
    "An opted-in delegate accepts execution options and retains its conversation on follow-up.",
  async test(t) {
    const started = await t.send(
      [
        "Alice wants to keep a note in a separate worker conversation.",
        "Call selectable-worker with the message 'Remember Alice's note: cobalt lantern'.",
        "For that new child, set execution.model to openai/gpt-5.5, execution.reasoning to low, and execution.maxCostUsd to 0.5.",
        "After it replies, send the same worker a follow-up using its agentId, without execution options, asking for Alice's note.",
        "Then report the note to Alice. Do not start a second worker.",
      ].join(" "),
    );
    started.expectOk();
    const streamIndex = t.state?.streamIndex;
    if (streamIndex === undefined) throw new Error("Parent session has no stream index.");
    const completed = await t.target
      .watchTurn(started.sessionId, { startIndex: streamIndex })
      .result();
    completed.expectOk();
    completed.messageIncludes("cobalt lantern");
    t.succeeded();
    t.calledSubagent("selectable-worker", { count: 2 });
    t.noFailedActions();
  },
});
