import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/** The id the scripted parent gives its `eve__execute` call; its agent call takes `<id>/1`. */
const PROGRAM_CALL = "cancel-sleeper";

export default defineEval({
  description:
    "Cancelling a turn held by an eve__execute program stops the program and cancels the sleeper session its agent call opened.",
  timeoutMs: 240_000,

  async test(t) {
    const session = await t.session();
    // The directive phrase selects a scripted program, so the mock model drives this eval on
    // every world.
    const parent = await session.start(
      "Alice wants the sleeper to hold its turn while she checks that stopping works. Please ask the sleeper agent from one program to wait for cancellation, and return what it replies.",
    );
    const started = await parent.waitForEvent("child.opened", {
      data: { name: "sleeper" },
    });

    const child = t.target.attach(started.data.sessionId).watch();
    await child.waitForEvent("call.requested", {
      data: { capability: { name: "wait-for-cancellation" } },
    });

    const cancelled = await parent.cancel();
    await t.require(
      cancelled,
      satisfies(
        (value: typeof cancelled) => typeof value.deliveryId === "string",
        "parent cancel request is accepted",
      ),
    );

    const [parentTurn, childTurn] = await Promise.all([parent.result(), child.result()]);
    childTurn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    childTurn.eventOrder([{ data: { outcome: "cancelled" }, type: "turn.settled" }]);
    childTurn.notEvent("turn.settled", { data: { outcome: "failed" } });
    childTurn.notEvent("session.ended", { data: { outcome: "failed" } });

    parentTurn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    parentTurn.eventOrder([{ data: { outcome: "cancelled" }, type: "turn.settled" }]);
    parentTurn.notEvent("turn.settled", { data: { outcome: "failed" } });
    parentTurn.notEvent("session.ended", { data: { outcome: "failed" } });
    // The program held the turn: its agent call opened the sleeper's session and was never a task.
    parentTurn.event("child.opened", {
      count: 1,
      data: { name: "sleeper", owner: { callId: `${PROGRAM_CALL}/1` } },
    });
    parentTurn.notEvent("task.started");
    // The cancel stops both calls before either returns a value.
    parentTurn.calledTool(EXECUTE_TOOL, { count: 1, status: "interrupted" });
    parentTurn.calledTool("sleeper", { count: 1, status: "interrupted" });

    // The follow-up answers only when history keeps the cancelled program call.
    const followUp = await session.send("Reply with exactly CANCELLATION-SUBAGENT-FOLLOW-UP-OK.");
    followUp.expectOk();
    followUp.notEvent("turn.settled", { data: { outcome: "cancelled" } });
    followUp.messageIncludes(/CANCELLATION-SUBAGENT-FOLLOW-UP-OK/i);

    // The eval watches both the parent and the sleeper session; each one's turn is cancelled once.
    t.event("turn.settled", { count: 2, data: { outcome: "cancelled" } });
  },
});
