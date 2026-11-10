import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Alice can prepare her new private chat while another issuer cannot read or control it.",
  async test(t) {
    const alice = { authorization: "Bearer e2e-create-once-a" };
    const bob = { authorization: "Bearer e2e-create-once-b" };
    const created = await t.target.fetch("/eve/v1/session", {
      method: "POST",
      headers: alice,
      body: "{}",
    });
    await t.require(created.status, equals(202));
    const { sessionId } = (await created.json()) as { sessionId: string };
    const sessionPath = `/eve/v1/session/${encodeURIComponent(sessionId)}`;
    try {
      for (const [method, path] of [
        ["GET", `${sessionPath}/stream?follow=false`],
        ["POST", `${sessionPath}/cancel`],
        ["POST", sessionPath],
      ]) {
        const response = await t.target.fetch(path!, { method, headers: bob });
        await t.require(response.status, equals(403));
        await response.body?.cancel();
      }
      const prepared = await t.target.fetch(sessionPath, { method: "POST", headers: alice });
      await t.require(prepared.ok, equals(true));
      await prepared.body?.cancel();
    } finally {
      const ended = await t.target.fetch(`${sessionPath}/end`, { method: "POST", headers: alice });
      await ended.body?.cancel();
    }
  },
});
