import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { ALICE, BOB, SAY } from "../helpers.ts";

interface Delivery {
  readonly ok: boolean;
  readonly sessionId?: string;
}

/** Posts to the shared thread as `principalId`, the way a teammate would. */
async function postMessage(
  target: EveEvalTargetHandle,
  threadId: string,
  principalId: string,
  message: string,
): Promise<Delivery> {
  const path = `/shared/${threadId}/messages`;
  const response = await target.fetch(path, {
    body: JSON.stringify({ message }),
    headers: { "content-type": "application/json", "x-eve-fixture-user": principalId },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed (${response.status}): ${text}`);
  return JSON.parse(text) as Delivery;
}

/**
 * Alice asks for a slow report on a shared thread. While the report is being
 * prepared, Bob adds his access check to the same thread. His message joins
 * Alice's turn, which stays hers: the check reports Bob steered it, so Alice's
 * token is withheld until Alice's own next message clears him.
 */
export default defineEval({
  description: "Another person's message joins a running turn, which keeps its caller and token.",
  tags: ["hitl", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const threadId = crypto.randomUUID();
    const started = await postMessage(t.target, threadId, ALICE, SAY.slowReport);
    await t.require(
      started,
      satisfies(
        (value: Delivery) => value.ok === true && typeof value.sessionId === "string",
        "the shared thread starts a session",
      ),
    );
    const sessionId = started.sessionId!;

    const turn = t.target.attach(sessionId).watch();
    await turn.waitForEvent("call.requested", { data: { capability: { name: "slow-step" } } });

    const joined = await postMessage(t.target, threadId, BOB, SAY.bobAccess);
    await t.require(
      joined,
      satisfies(
        (value: Delivery) => value.sessionId === sessionId,
        "Bob's message joins Alice's running turn in the same session",
      ),
    );

    const steered = await turn.result();
    steered.expectOk();
    steered.event("turn.started", { count: 1 });
    steered.event("delivery.consumed", {
      data: { parts: [{ kind: "text", text: SAY.bobAccess }] },
    });
    steered.calledTool("access-report", {
      status: "completed",
      count: 1,
      output: { caller: ALICE, steeredBy: [BOB], access: "turn_steered" },
    });
    steered.event("turn.settled", { count: 1, data: { outcome: "completed" } });

    const confirmed = await postMessage(t.target, threadId, ALICE, SAY.aliceConfirms);
    await t.require(
      confirmed,
      satisfies(
        (value: Delivery) => value.sessionId === sessionId,
        "Alice's next message resumes the same session",
      ),
    );
    const followUp = await t.target
      .attach(sessionId, { startIndex: steered.session.state?.streamIndex })
      .watch()
      .result();
    followUp.event("turn.started", { count: 1 });
    followUp.calledTool("access-report", {
      status: "completed",
      count: 1,
      output: { caller: ALICE, steeredBy: [], access: "granted" },
    });

    t.succeeded();
  },
});
