import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Alice's workspace allows her session access while Bob waits for membership approval.",
  tags: ["client", "regression"],
  async test(t) {
    const session = await t.session();
    const path = `/eve/v1/session/${encodeURIComponent(session.id)}`;
    const restricted = { authorization: "Bearer e2e-restricted-session-access" };

    const read = await t.target.fetch(`${path}/stream?follow=false`, {
      headers: restricted,
      signal: t.abortSignal,
    });
    await t.require(read.status, equals(403));
    await t.require((await read.json()).code, equals("session_access_denied"));

    const reset = await t.target.fetch(`${path}/reset`, {
      method: "POST",
      headers: restricted,
      signal: t.abortSignal,
    });
    await t.require(reset.status, equals(403));
    await t.require((await reset.json()).code, equals("session_access_denied"));

    const allowed = await t.target.fetch(`${path}/stream?follow=false`, {
      signal: t.abortSignal,
    });
    await t.require(allowed.status, equals(200));
    await allowed.text();

    const greeting = await session.start(
      "Alice has confirmed her workspace access. Greet her briefly without calling tools.",
    );
    (await greeting.result()).expectOk();
  },
});
