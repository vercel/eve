import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import type { CommitLine, Fact } from "eve/events";

export default defineEval({
  description:
    "Sessions retain their durable transcript after ending with both full and metadata-only trace capture.",
  async test(t) {
    const message =
      "Alice has finished reviewing her notes. Greet her briefly without calling tools.";
    for (const metadataOnly of [false, true]) {
      const headers: Record<string, string> = metadataOnly
        ? { authorization: "Bearer e2e-metadata-retention" }
        : {};
      const turn = await t.send(message, { headers });
      turn.expectOk();
      turn.event("content.completed", { count: 1, data: { kind: "text", phase: "reply" } });
      const sessionPath = `/eve/v1/session/${encodeURIComponent(turn.sessionId)}`;
      const readHistory = () =>
        t.target.fetch(`${sessionPath}/stream?follow=false&startIndex=0`, {
          headers,
          signal: t.abortSignal,
        });
      const live = await readHistory();
      await t.require(live.status, equals(200));
      await t.require((await live.text()).includes(message), equals(true));

      const ended = await t.target.fetch(`${sessionPath}/end`, {
        headers,
        method: "POST",
        signal: t.abortSignal,
      });
      await t.require(ended.status, equals(202));
      await ended.body?.cancel();
      let sessionEnded = false;
      for (const delayMs of [0, 50, 100, 200, 400, 800, 1_600, 3_200]) {
        await t.sleep(delayMs);
        const history = await readHistory();
        await t.require(history.status, equals(200));
        const body = await history.text();
        await t.require(body.includes(message), equals(true));
        sessionEnded = body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .some((line) => {
            const record = JSON.parse(line) as Partial<CommitLine<Fact>>;
            return record.facts?.some((fact) => fact.type === "session.ended") ?? false;
          });
        if (sessionEnded) break;
      }
      await t.require(sessionEnded, equals(true));

      const retained = await readHistory();
      await t.require(retained.status, equals(200));
      const history = await retained.text();
      await t.require(history.includes(message), equals(true));
    }
  },
});
