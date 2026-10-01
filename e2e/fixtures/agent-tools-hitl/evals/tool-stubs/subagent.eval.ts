import { defineEval } from "eve/evals";

/**
 * Tool stubs across a subagent: the `scheduler` subagent reads the stub state
 * the parent changed, and its call to a tool the set does not stub fails the
 * parent's turn.
 */
export default defineEval({
  description: "A subagent shares the parent's stub state, and its missing stub fails the parent.",
  async test(t) {
    if (t.target.kind !== "local") {
      t.skip("Stub sets are accepted only by the agent server that eve eval starts.");
    }

    const parked = await t.send(
      'Call the schedules_create tool exactly once with name "Canary check".',
      { stubs: "two-workflows" },
    );
    parked.session.requireInputRequest({ toolName: "schedules_create" });
    const created = await parked.session.respondAll("approve");
    created.expectOk();

    const read = await created.session.send(
      'Use the scheduler subagent with message "SCHEDULER read". Reply with its output verbatim.',
    );
    read.expectOk();
    read.calledSubagent("scheduler", { status: "completed" });
    read.messageIncludes("Canary check");

    const deleted = await read.session.send(
      'Use the scheduler subagent with message "SCHEDULER delete". Reply with its output verbatim.',
    );
    deleted.event("turn.failed", { data: { code: "TOOL_STUB_MISSING" }, count: 1 });
  },
});
