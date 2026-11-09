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
    const initial = await t.target.attach(accepted.sessionId).watch().result();
    initial.succeeded();

    const next = t.target
      .attach(accepted.sessionId, {
        startIndex: (initial.events.at(-1)?.meta.position.line ?? -1) + 1,
      })
      .watch();
    const followup = {
      message: "Bob joins Alice and asks for a brief outline of the report.",
      idempotencyKey: "bob-outline",
    };
    await Promise.all([send(first), send(followup), send(followup)]);
    const reply = await next.result();
    reply.succeeded();
    reply.event("delivery.consumed", {
      count: 1,
      data: { parts: [{ kind: "text", text: followup.message }] },
    });

    const barrier = t.target
      .attach(accepted.sessionId, {
        startIndex: (reply.events.at(-1)?.meta.position.line ?? -1) + 1,
      })
      .watch();
    const sentinel = {
      message:
        "Alice and Bob finish reviewing the outline. Acknowledge that the review is complete.",
    };
    await send(sentinel);
    const drained = await barrier.result();
    drained.succeeded();
    drained.event("delivery.consumed", {
      count: 1,
      data: { parts: [{ kind: "text", text: sentinel.message }] },
    });
    const response = await t.target.fetch(
      `/eve/v1/session/${accepted.sessionId}/stream?follow=false`,
    );
    await t.require(response.status, equals(200));
    const events = (await response.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => (JSON.parse(line) as { facts?: { type: string }[] }).facts ?? []);
    await t.require(events.filter((event) => event.type === "turn.started").length, equals(3));
  },
});
