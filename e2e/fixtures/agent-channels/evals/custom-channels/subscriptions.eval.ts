import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { postChannel } from "./shared";

export default defineEval({
  tags: ["real-model"],
  description:
    "A session that is only told a channel exists finds its events with eve__search, subscribes to one with the scope the search shows, and a redelivered event reaches it once.",
  async test(t) {
    const subscribed = await t.send(
      "Tell me when the build of the project `web` breaks, for the next 10 minutes. Reply `subscribed` once you are watching.",
    );
    subscribed.expectOk();
    const names = subscribed.toolCalls.map((call) => call.name);
    const searched = names.indexOf("eve__search");
    await t.require(searched >= 0 && searched < names.indexOf("eve__subscribe"), equals(true));
    t.calledTool("eve__subscribe", {
      count: 1,
      input: { source: "events", event: /^build\.(finished|failed)$/ },
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
