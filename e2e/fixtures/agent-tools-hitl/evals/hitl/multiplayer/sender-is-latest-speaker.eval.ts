import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  bobSteers,
  expectWaitsAsTask,
} from "../helpers.ts";

/**
 * Bob's note joins Alice's turn while her change waits for approval. A tool the model calls for
 * it reads Alice as the turn's caller and Bob as the person who spoke last.
 */
export default defineEval({
  description: "A tool reads the turn's caller and its latest sender after someone else speaks.",
  tags: ["hitl", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const joined = (await session.send(SAY.bobSpeakers, bobSteers)).expectOk();
    joined.calledTool("speakers", {
      status: "completed",
      output: { caller: "alice", sender: "bob" },
      count: 1,
    });
    expectWaitsAsTask(joined, request);

    const approved = (await session.respond(answers("approve", request), asAlice)).expectOk();
    approved.calledTool("change-a", { status: "completed", count: 1 });
    approved.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
