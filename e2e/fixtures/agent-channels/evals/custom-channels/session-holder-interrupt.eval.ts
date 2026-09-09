import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { postChannel } from "./shared";

type MessageResponse = { ok: boolean; sessionId?: string };

export default defineEval({
  description:
    "An interrupt replaces an active tool turn through the same session stream without an idle boundary.",
  timeoutMs: 240_000,
  async test(t) {
    const sessionRef = crypto.randomUUID();
    const first = await postChannel<MessageResponse>(t.target, "/webhook", {
      message: "Wait for a replacement turn. Call wait-for-cancellation now.",
      sessionRef,
    });
    await t.require(
      first.sessionId,
      satisfies((id) => typeof id === "string", "creation returns a ready session"),
    );
    const live = t.target.watchTurn(first.sessionId!);
    await live.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some(
            (action) => action.kind === "tool-call" && action.toolName === "wait-for-cancellation",
          ),
      },
    });
    const replacement = await postChannel<MessageResponse>(t.target, "/webhook", {
      message: "Reply with exactly: replacement-turn-complete",
      sessionRef,
      turnPolicy: "interrupt",
    });
    await t.require(replacement.sessionId, equals(first.sessionId));
    const result = await live.result();
    result.event("turn.interrupted", { count: 1 });
    result.notEvent("turn.cancelled");
    result.notEvent("session.failed");
    result.messageIncludes("replacement-turn-complete");
    result.eventsSatisfy("the replacement begins before the stream announces idle", (events) => {
      const interrupted = events.findIndex((event) => event.type === "turn.interrupted");
      const replacementStart = events.findIndex(
        (event, index) => index > interrupted && event.type === "turn.started",
      );
      return (
        interrupted >= 0 &&
        replacementStart > interrupted &&
        events
          .slice(interrupted, replacementStart)
          .every((event) => event.type !== "session.waiting")
      );
    });
    t.succeeded();
  },
});
