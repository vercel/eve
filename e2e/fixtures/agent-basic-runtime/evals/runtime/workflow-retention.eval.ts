import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "Metadata-only sessions lose their durable transcript after reset, while full-capture sessions retain it.",
  async test(t) {
    const message =
      "Alice has finished reviewing her notes. Greet her briefly without calling tools.";
    for (const metadataOnly of [false, true]) {
      const headers: Record<string, string> = metadataOnly
        ? { authorization: "Bearer e2e-metadata-retention" }
        : {};
      const turn = await t.send(message, { headers });
      turn.expectOk();
      turn.event("message.completed", { count: 1 });
      const sessionPath = `/eve/v1/session/${encodeURIComponent(turn.sessionId)}`;
      const readHistory = () =>
        t.target.fetch(`${sessionPath}/stream?follow=false&startIndex=0`, {
          headers,
          signal: t.signal,
        });
      const live = await readHistory();
      await t.require(live.status, equals(200));
      await t.require((await live.text()).includes(message), equals(true));

      const reset = await t.target.fetch(`${sessionPath}/reset`, {
        headers,
        method: "POST",
        signal: t.signal,
      });
      await t.require(reset.status, equals(200));
      await reset.body?.cancel();
      if (!metadataOnly) {
        const retained = await readHistory();
        await t.require(retained.status, equals(200));
        await t.require((await retained.text()).includes(message), equals(true));
        continue;
      }

      let purged = false;
      for (const delayMs of [0, 50, 100, 200, 400, 800, 1_600, 3_200]) {
        await t.sleep(delayMs);
        const history = await readHistory();
        if (history.status === 410) {
          await t.require((await history.json()).code, equals("session_expired"));
          purged = true;
          break;
        }
        await t.require(history.status, equals(200));
        let body: string;
        try {
          body = await history.text();
        } catch (error) {
          // A purge can interrupt a read after the server commits its 200 response.
          if (!(error instanceof TypeError)) throw error;
          t.signal.throwIfAborted();
          continue;
        }
        if (body.trim().length === 0) {
          purged = true;
          break;
        }
      }
      await t.require(
        purged,
        satisfies(
          (value: boolean) => value,
          "metadata-only session history is expired or empty after reset",
        ),
      );
    }
  },
});
