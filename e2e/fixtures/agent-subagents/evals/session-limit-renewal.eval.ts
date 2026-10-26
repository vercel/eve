import { defineEval, type EveEvalSession } from "eve/evals";
import { equals } from "eve/evals/expect";

import { LEASE_DIRECTIVE } from "../constants";

/**
 * One Continue raises the whole tree's allowance. The parent starts two
 * workers; worker a crosses its 40M window at 45M and asks while worker b is
 * still reading. The Continue moves the parent's window to a's 45M and b's to
 * its own 30M, so b finishes without asking. Once both report, the tree has
 * spent 90M against the 85M approved, so the parent asks once more.
 */
export default defineEval({
  description: "One session-limit Continue raises the allowance of every session in the tree.",
  timeoutMs: 120_000,
  async test(t) {
    const { session } = await t.send(`${LEASE_DIRECTIVE} Survey every station.`);
    let cursor: SessionCursor = session;
    const asks: string[] = [];
    let reply = "";
    for (let turn = 0; turn < 8; turn += 1) {
      const pending = cursor.pendingInputRequests;
      if (pending.length > 0) {
        const request = cursor.requireInputRequest({
          display: "confirmation",
          optionIds: ["continue", "stop"],
          toolName: "session_limit_continuation",
        });
        asks.push(request.requestId);
        const resumed = await cursor.respond([
          { optionId: "continue", requestId: request.requestId },
        ]);
        resumed.expectOk();
        reply = resumed.message ?? "";
        if (reply.includes("LEASE-REPLY")) break;
        continue;
      }
      if (cursor.state === undefined || cursor.sessionId === undefined) break;
      const live = t.target.watchTurn(cursor.sessionId, { startIndex: cursor.state.streamIndex });
      const next = await live.result();
      next.expectOk();
      cursor = live.session;
      reply = next.message ?? "";
      if (reply.includes("LEASE-REPLY")) break;
    }
    t.check(asks.length, equals(2));
    t.check(reply, equals("LEASE-REPLY lease-worker-a read 3 pages | lease-worker-b read 3 pages"));
  },
});

type SessionCursor = Pick<
  EveEvalSession,
  "pendingInputRequests" | "requireInputRequest" | "respond" | "sessionId" | "state"
>;
