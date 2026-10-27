import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Alice starts a private conversation, continues it later, and keeps it separate from Bob's workspace identity.",
  tags: ["client", "regression"],
  async test(t) {
    const alice = { authorization: "Bearer fixture-alice" };
    const bob = { authorization: "Bearer fixture-bob" };
    const created = await t.target.fetch("/eve/v1/session", {
      method: "POST",
      headers: alice,
      signal: t.abortSignal,
    });
    await t.require(created.status, equals(202));
    const { sessionId } = (await created.json()) as { sessionId: string };
    const path = `/eve/v1/session/${encodeURIComponent(sessionId)}`;

    for (const [headers, expected] of [
      [alice, 200],
      [bob, 403],
    ] as const) {
      const stream = await t.target.fetch(`${path}/stream?follow=false`, {
        headers,
        signal: t.abortSignal,
      });
      await t.require(stream.status, equals(expected));
      await stream.text();
    }
    const refused = await t.target.fetch(`${path}/reset`, {
      method: "POST",
      headers: bob,
      signal: t.abortSignal,
    });
    await t.require(refused.status, equals(403));
    await refused.text();

    const sent = await t.target.fetch(path, {
      method: "POST",
      headers: { ...alice, "content-type": "application/json" },
      body: JSON.stringify({
        message: "Alice is returning to her workday planning. Greet her briefly.",
      }),
      signal: t.abortSignal,
    });
    await t.require(sent.status, equals(202));
    (await t.target.attach(sessionId).watch().result()).expectOk();
  },
});
