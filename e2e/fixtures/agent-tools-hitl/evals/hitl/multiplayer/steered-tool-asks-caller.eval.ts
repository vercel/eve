import { defineEval } from "eve/evals";

import {
  ALICE,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asBob,
  bobSteers,
  expectWaitsAsTask,
} from "../helpers.ts";

/**
 * Alice's change waits for her approval when Bob's note joins her turn and asks for the release
 * note. The release-note tool's `steered()` policy stops the call before it starts, and eve asks
 * Alice to approve it, quoting Bob. Bob presses Approve too, and only Alice's approval counts: the
 * note posts for her, and reads her as the last to speak. Her approval then runs the change.
 */
export default defineEval({
  description: "A tool steered() marks asks the caller after someone else speaks.",
  tags: ["hitl", "approval", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const asked = (await session.send(SAY.bobReleaseNote, bobSteers)).expectOk();
    const note = approvalFor(asked, "release-note");
    asked.event("interaction.opened", {
      count: 1,
      data: {
        audience: { principalIds: [ALICE] },
        interactionId: note.interactionId,
        request: { kind: "approval", prompt: (prompt) => prompt.includes(SAY.bobReleaseNote) },
      },
    });
    asked.notEvent("call.started", { data: { callId: note.call?.callId } });
    expectWaitsAsTask(asked, request);

    const refused = await session.startRespond(answers("approve", note), asBob);
    await refused.waitForEvent("response.settled", {
      data: { outcome: "refused", reason: (reason) => reason?.startsWith('Only "alice"') ?? false },
    });
    await refused.result();

    const approved = (await session.respond(answers("approve", note), asAlice)).expectOk();
    approved.calledTool("release-note", {
      status: "completed",
      output: { postedFor: "alice", sender: "alice" },
      count: 1,
    });

    const done = (await session.respond(answers("approve", request), asAlice)).expectOk();
    done.calledTool("change-a", { status: "completed", count: 1 });
    done.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
