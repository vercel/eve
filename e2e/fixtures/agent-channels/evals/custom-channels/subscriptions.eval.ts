import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { postChannel } from "./shared";

export default defineEval({
  tags: ["real-model"],
  description:
    "A session subscribes to a channel's event with the scope its instructions describe, and a redelivered event reaches it once.",
  async test(t) {
    const subscribed = await t.send(
      "Tell me when the build of the project `web` breaks, for the next 10 minutes. Reply `subscribed` once you are watching.",
    );
    subscribed.expectOk();
    // The trace names the entry `eve__subscribe` routed to, not the route the model called.
    t.calledTool("eve__subscribe_channel", {
      count: 1,
      input: { subscription: { source: "events", event: /^build\.(finished|failed)$/ } },
    });

    const sessionId = subscribed.sessionId;
    const emit = (id: string) =>
      postChannel<{ delivered: boolean }>(t.target, "/events/emit", {
        event: "build.failed",
        id,
        project: "web",
      });
    const once = `once-${crypto.randomUUID()}`;
    const next = t.target
      .attach(sessionId, {
        startIndex: (subscribed.events.at(-1)?.meta.position.line ?? -1) + 1,
      })
      .watch();
    const first = await emit(once);
    const redelivered = await emit(once);
    await t.require(first.delivered, equals(true));
    await t.require(redelivered.delivered, equals(true));
    const delivery = await next.result();
    delivery.succeeded();

    const barrier = `barrier-${crypto.randomUUID()}`;
    const drained = t.target
      .attach(sessionId, {
        startIndex: (delivery.events.at(-1)?.meta.position.line ?? -1) + 1,
      })
      .watch();
    await emit(barrier);
    (await drained.result()).succeeded();

    const response = await t.target.fetch(`/eve/v1/session/${sessionId}/stream?follow=false`);
    await t.require(response.status, equals(200));
    const text = await response.text();
    const consumed = (id: string) =>
      text.split("\n").filter((line) => line.includes("delivery.consumed") && line.includes(id))
        .length;
    await t.require(consumed(once), equals(1));
    await t.require(consumed(barrier), equals(1));
  },
});
