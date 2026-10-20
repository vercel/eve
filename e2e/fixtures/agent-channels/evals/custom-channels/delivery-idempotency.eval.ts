import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { postChannel } from "./shared";

export default defineEval({
  description: "Retries of a channel delivery keep one session and one copy of agent input.",
  async test(t) {
    const path = `/deliveries/${crypto.randomUUID()}`;
    const first = {
      message: "Alice opens a conversation about preparing a report. Acknowledge her request.",
      idempotencyKey: "alice-report",
    };
    const send = (body: { message: string; idempotencyKey?: string }) =>
      postChannel<{ sessionId: string }>(t.target, path, body);
    const [accepted, retry] = await Promise.all([send(first), send(first)]);
    await t.require(retry.sessionId, equals(accepted.sessionId));
    const initial = await t.target.watchTurn(accepted.sessionId).result();
    initial.succeeded();

    const next = t.target.watchTurn(accepted.sessionId, { startIndex: initial.events.length });
    const followup = {
      message: "Bob joins Alice and asks for a brief outline of the report.",
      idempotencyKey: "bob-outline",
    };
    await Promise.all([send(first), send(followup), send(followup)]);
    const reply = await next.result();
    reply.succeeded();
    await t.require(
      reply.events
        .filter((event) => event.type === "message.received")
        .map((event) => event.data.message),
      equals([followup.message]),
    );

    const barrier = t.target.watchTurn(accepted.sessionId, {
      startIndex: initial.events.length + reply.events.length,
    });
    const sentinel = {
      message:
        "Alice and Bob finish reviewing the outline. Acknowledge that the review is complete.",
    };
    await send(sentinel);
    const drained = await barrier.result();
    drained.succeeded();
    await t.require(
      drained.events
        .filter((event) => event.type === "message.received")
        .map((event) => event.data.message),
      equals([sentinel.message]),
    );
    const response = await t.target.fetch(
      `/eve/v1/session/${accepted.sessionId}/stream?follow=false`,
    );
    await t.require(response.status, equals(200));
    const events = (await response.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    await t.require(events.filter((event) => event.type === "turn.started").length, equals(3));
  },
});
