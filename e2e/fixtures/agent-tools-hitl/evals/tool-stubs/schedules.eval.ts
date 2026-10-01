import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

/**
 * Tool stubs: the `two-workflows` stub set answers the schedule tools in place
 * of their real execute, keeps its state across an approval and later turns,
 * and fails the turn for an authored tool it does not stub.
 */
export default defineEval({
  description: "A stub set answers tool calls, keeps state, and fails closed.",
  async test(t) {
    if (t.target.kind !== "local") {
      t.skip("Stub sets are accepted only by the agent server that eve eval starts.");
    }

    const unknown = await t
      .send("Call the schedules_read tool exactly once.", { stubs: "three-workflows" })
      .then(
        () => "created",
        (error: unknown) => String(error),
      );
    t.check(unknown, includes('Unknown stub set "three-workflows"'));

    const first = await t.send("Call the schedules_read tool exactly once.", {
      stubs: "two-workflows",
    });
    first.expectOk();
    first.calledTool("schedules_read", { status: "completed", count: 1 });
    first.messageIncludes("Weekly commit activity");

    const parked = await first.session.send(
      'Call the schedules_create tool exactly once with name "Canary check".',
    );
    parked.session.requireInputRequest({ toolName: "schedules_create" });
    const created = await parked.session.respondAll("approve");
    created.expectOk();
    created.calledTool("schedules_create", { status: "completed", count: 1 });

    const listed = await created.session.send("Call the schedules_read tool exactly once.");
    listed.expectOk();
    listed.messageIncludes("Weekly commit activity");
    listed.messageIncludes("Canary check");

    const unstubbed = await listed.session.send(
      'Call the read-status tool exactly once with marker "tool-stubs".',
    );
    unstubbed.event("turn.failed", { data: { code: "TOOL_STUB_MISSING" }, count: 1 });
  },
});
