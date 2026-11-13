import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { ALICE, BOB, SAY, postMessage, type SharedDelivery } from "../helpers.ts";

/**
 * Alice asks for a slow report on a shared thread. While the report is being
 * prepared, Bob hands the thread over to himself: his message joins Alice's
 * turn and becomes its caller. The access check reports Bob with his own token.
 */
export default defineEval({
  description: "Another person's handover message makes a running turn adopt its sender.",
  tags: ["hitl", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const threadId = crypto.randomUUID();
    const started = await postMessage(t.target, "messages", threadId, ALICE, SAY.slowReport);
    await t.require(
      started,
      satisfies(
        (value: SharedDelivery) => value.ok === true && typeof value.sessionId === "string",
        "the shared thread starts a session",
      ),
    );
    const sessionId = started.sessionId!;

    // `slow-step` waits for the next message, so this POST is never a race.
    const turn = t.target.attach(sessionId).watch();
    await turn.waitForEvent("call.requested", { data: { capability: { name: "slow-step" } } });

    const handover = await postMessage(t.target, "handover", threadId, BOB, SAY.bobAccess);
    await t.require(
      handover,
      satisfies(
        (value: SharedDelivery) => value.sessionId === sessionId,
        "Bob's handover message joins Alice's running turn in the same session",
      ),
    );

    const adopted = await turn.result();
    adopted.expectOk();
    adopted.event("turn.started", { count: 1 });
    adopted.event("delivery.consumed", {
      data: { parts: [{ kind: "text", text: SAY.bobAccess }] },
    });
    adopted.calledTool("access-report", {
      status: "completed",
      count: 1,
      output: { caller: BOB, steeredBy: [], access: "granted" },
    });
    adopted.event("turn.settled", { count: 1, data: { outcome: "completed" } });

    t.succeeded();
  },
});
