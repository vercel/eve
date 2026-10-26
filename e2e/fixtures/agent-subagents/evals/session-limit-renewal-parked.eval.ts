import { defineEval, type EveEvalSession } from "eve/evals";
import { equals } from "eve/evals/expect";

import { LEASE_PARKED_DIRECTIVE } from "../constants";

/**
 * A Continue reaches a worker that is already waiting on its own prompt. Both
 * workers cross their 40M windows at 45M and ask. Continue on one raises the
 * parent's allowance by the 90M both prompts show: the other worker's prompt
 * resolves as approved, its prompt at the parent closes, and the turn
 * completes with one answer.
 */
export default defineEval({
  description: "One approval settles a sibling's session-limit prompt that is already waiting.",
  timeoutMs: 120_000,
  async test(t) {
    const { session } = await t.send(`${LEASE_PARKED_DIRECTIVE} Survey every station.`);
    let cursor: SessionCursor = session;
    const asked = new Set<string>();
    const answered: string[] = [];
    let reply = "";
    for (let turn = 0; turn < 12; turn += 1) {
      const pending = cursor.pendingInputRequests.filter(
        (request) => !answered.includes(request.requestId),
      );
      for (const request of pending) asked.add(request.requestId);
      // Answer only once both workers wait, so the renewal reaches a parked sibling.
      if (pending.length > 0 && (asked.size >= 2 || answered.length > 0)) {
        const [request] = pending;
        t.check(request?.action?.toolName, equals("session_limit_continuation"));
        answered.push(request!.requestId);
        const resumed = await cursor.respond([
          { optionId: "continue", requestId: request!.requestId },
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
    t.check(answered.length, equals(1));
    t.check(reply, equals("LEASE-REPLY lease-worker-a read 3 pages | lease-worker-b read 3 pages"));
  },
});

type SessionCursor = Pick<
  EveEvalSession,
  "pendingInputRequests" | "respond" | "sessionId" | "state"
>;
