import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { postChannel } from "./shared";

type MessageResponse = { ok: boolean; sessionId?: string };

export default defineEval({
  description:
    "Concurrent first deliveries resolve one ready holder and preserve both accepted inputs.",
  timeoutMs: 240_000,
  async test(t) {
    const sessionRef = crypto.randomUUID();
    const messages = [
      "Reply with exactly: concurrent-first-input",
      "Reply with exactly: concurrent-second-input",
    ];
    const responses = await Promise.all(
      messages.map((message) =>
        postChannel<MessageResponse>(t.target, "/webhook", {
          message,
          sessionRef,
          turnPolicy: "queue",
        }),
      ),
    );
    const sessionId = responses[0]?.sessionId;
    await t.require(
      sessionId,
      satisfies((id) => typeof id === "string", "creation returns a session"),
    );
    await t.require(responses[1]?.sessionId, equals(sessionId));
    const received = new Set<string>();
    let startIndex = 0;
    // Each accepted input can settle its own turn or share the initial turn.
    // Read at most their two natural stream boundaries, without readiness polling.
    for (let turn = 0; turn < messages.length && received.size < messages.length; turn += 1) {
      const result = await t.target.watchTurn(sessionId!, { startIndex }).result();
      result.succeeded();
      result.notEvent("session.failed");
      startIndex += result.events.length;
      for (const event of result.events) {
        if (event.type === "message.received" && typeof event.data.message === "string") {
          for (const message of messages)
            if (event.data.message.includes(message)) received.add(message);
        }
      }
    }
    await t.require([...received].sort(), equals([...messages].sort()));
    const followup = await postChannel<MessageResponse>(t.target, "/webhook", {
      message: "Reply with exactly: immediate-followup-ready",
      sessionRef,
    });
    await t.require(followup.sessionId, equals(sessionId));
    const completed = await t.target.watchTurn(sessionId!, { startIndex }).result();
    completed.succeeded();
    completed.messageIncludes("immediate-followup-ready");
  },
});
