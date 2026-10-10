import { defineEval } from "eve/evals";

const NOTES = { notes: ["draft", "final"] };

/**
 * `collect_notes` is a `serve` tool that holds a note sent with `more` until
 * the next one arrives, then replies once for both. The model sends two notes
 * to one task and waits: the reply settles both calls in one step, so the wait
 * reports the task done, with nothing still working, and the model receives
 * the reply once.
 */
export default defineEval({
  description: "One reply that answers two calls settles both together and reaches the model once.",
  async test(t) {
    const turn = await t.send("WORKFLOW-NOTES-BATCH");
    turn.expectOk();
    turn.calledTool("collect_notes", { count: 2 });
    turn.calledTool("eve__task_wait", {
      count: 1,
      output: /^collect_notes-\w{6} completed; its result follows\.$/u,
    });
    // The reply settles both calls; the second refers to the first's output instead of repeating it.
    turn.calledTool("collect_notes", { count: 2, output: NOTES });
    for (const callId of ["notes-draft", "notes-final"]) {
      turn.event("call.settled", { count: 1, data: { callId, outcome: "completed" } });
    }
    turn.messageIncludes(`WORKFLOW-NOTES-RESULT 1 ${JSON.stringify(NOTES)}`);
    t.noFailedActions();
  },
});
