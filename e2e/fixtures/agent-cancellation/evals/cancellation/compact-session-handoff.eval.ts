import { defineEval, type EveEvalTurn } from "eve/evals";

function expectCompaction(compacted: EveEvalTurn): void {
  compacted.event("compaction.requested", { count: 1 });
  compacted.event("compaction.completed", { count: 1 });
  compacted.eventOrder([
    { type: "compaction.requested" },
    { type: "compaction.completed" },
    { type: "session.waiting" },
  ]);
  compacted.notEvent("turn.started");
  compacted.notEvent("session.failed");
}

/**
 * Keep a conversation going across repeated compactions.
 *
 * Each compaction moves the idle session to a fresh workflow run on the same
 * deployment. The session keeps its ID, event stream, and conversation, so
 * later messages still stream normally and a fact from before both
 * compactions is still known.
 */
export default defineEval({
  description: "Continue a session and its conversation across repeated compactions.",
  timeoutMs: 240_000,

  async test(t) {
    const session = await t.session();

    const opening = await session.send(
      "Alice is starting a project with the code word ORCHID-42. Acknowledge it in one short sentence.",
    );
    opening.expectOk();

    expectCompaction(await session.compact());

    const update = await session.send(
      "Bob joins Alice's project and asks for a status check. Reply with exactly STATUS-AFTER-COMPACTION-OK.",
    );
    update.expectOk();
    update.notEvent("session.failed");
    update.messageIncludes(/STATUS-AFTER-COMPACTION-OK/);

    expectCompaction(await session.compact());

    const recall = await session.send(
      "What is Alice's project code word? Reply with only the code word.",
    );
    recall.expectOk();
    recall.notEvent("session.failed");
    recall.messageIncludes(/ORCHID-42/);

    t.succeeded();
  },
});
