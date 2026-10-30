import { defineEval } from "eve/evals";
import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asBob,
  expectResolved,
} from "../helpers.ts";

export default defineEval({
  description:
    "An approved call runs as the requester and also reads the responder and their credentials.",
  tags: ["hitl", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.releaseGrant, asAlice), "release-grant");
    const approved = (await session.respond(answers("approve", request), asBob)).expectOk();
    expectResolved(approved, request, "accepted");
    approved.calledTool("release-grant", {
      count: 1,
      output: {
        requester: "alice",
        requesterToken: "release-token:alice",
        responder: "bob",
        responderToken: "release-token:bob",
      },
      status: "completed",
    });
  },
});
