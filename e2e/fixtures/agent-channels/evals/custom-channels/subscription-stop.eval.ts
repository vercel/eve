import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { postChannel } from "./shared";

const POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 250;

export default defineEval({
  description:
    "A subscription delivers an event to its session, and once the session stops it no event reaches the session.",
  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("Requires the deterministic model's subscription script.");
    }

    const project = `web-${crypto.randomUUID()}`;
    const subscribed = await t.send(`SUBSCRIBE ${project}`);
    subscribed.expectOk();
    subscribed.calledTool("eve__subscribe_channel", { count: 1, status: "completed" });
    const { id } = resultOf(subscribed.reply, "active");

    const emit = (eventId: string) =>
      postChannel<{ delivered: boolean }>(t.target, "/events/emit", {
        event: "build.failed",
        id: eventId,
        project,
      });
    const sessionId = subscribed.sessionId;
    const heard = t.target
      .attach(sessionId, {
        startIndex: (subscribed.events.at(-1)?.meta.position.line ?? -1) + 1,
      })
      .watch();
    const before = `before-${crypto.randomUUID()}`;
    await t.require((await emit(before)).delivered, equals(true));
    const delivery = await heard.result();
    delivery.succeeded();

    const stopped = await t.send(`STOP ${id}`);
    stopped.expectOk();
    stopped.calledTool("eve__subscription_stop", { count: 1, status: "completed" });
    resultOf(stopped.reply, "stopping");

    const after: string[] = [];
    let delivered = true;
    for (let attempt = 0; delivered && attempt < POLL_ATTEMPTS; attempt++) {
      const eventId = `after-${attempt}-${crypto.randomUUID()}`;
      after.push(eventId);
      delivered = (await emit(eventId)).delivered;
      if (delivered) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    await t.require(delivered, equals(false));

    const response = await t.target.fetch(`/eve/v1/session/${sessionId}/stream?follow=false`);
    await t.require(response.status, equals(200));
    const text = await response.text();
    const consumed = (eventId: string) =>
      text
        .split("\n")
        .filter((line) => line.includes("delivery.consumed") && line.includes(eventId)).length;
    await t.require(consumed(before), equals(1));
    await t.require(consumed(after.at(-1)!), equals(0));
  },
});

function resultOf(reply: string | undefined, status: string): { id: string } {
  const json = /SUBSCRIPTION-RESULT (\{.*\})/u.exec(reply ?? "")?.[1];
  const { error, output } = JSON.parse(json ?? "{}") as {
    error?: boolean;
    output?: { id?: string; status?: string };
  };
  if (error !== false || output?.status !== status || typeof output.id !== "string")
    throw new Error(`Expected a ${status} subscription, got ${reply ?? "no reply"}.`);
  return { id: output.id };
}
