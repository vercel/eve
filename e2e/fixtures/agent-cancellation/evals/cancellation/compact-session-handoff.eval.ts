import { defineEval, type EveEvalTurn } from "eve/evals";

function expectCompaction(compacted: EveEvalTurn): void {
  compacted.event("context.started", { count: 1, data: { kind: "compaction" } });
  compacted.event("context.settled", {
    count: 1,
    data: { kind: "compaction", outcome: "completed" },
  });
  compacted.eventOrder([
    { data: { kind: "compaction" }, type: "context.started" },
    { data: { kind: "compaction", outcome: "completed" }, type: "context.settled" },
  ]);
  compacted.notEvent("turn.started");
  compacted.notEvent("session.ended", { data: { outcome: "failed" } });
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
    update.notEvent("session.ended", { data: { outcome: "failed" } });
    update.messageIncludes(/STATUS-AFTER-COMPACTION-OK/);

    expectCompaction(await session.compact());

    const recall = await session.send(
      "What is Alice's project code word? Reply with only the code word.",
    );
    recall.expectOk();
    recall.notEvent("session.ended", { data: { outcome: "failed" } });
    recall.messageIncludes(/ORCHID-42/);

    t.succeeded();
  },
});
