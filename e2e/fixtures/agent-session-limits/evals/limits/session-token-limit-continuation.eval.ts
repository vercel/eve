import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

/**
 * Session token limits over HTTP: a conversation session that crosses its
 * input budget parks on the deterministic `session_limit_continuation`
 * prompt instead of failing. Approving grants a fresh budget window and
 * processes the queued message; declining cancels the in-flight turn
 * (`turn.cancelled` → `session.waiting`) and keeps the session resumable —
 * a user decision, not an error and not a session end.
 */
export default defineEval({
  description: "Session token limit parks on a continuation prompt; approve resumes, stop cancels.",
  async test(t) {
    // The 1-token budget lets this first call finish (limits are checked
    // before the next call) but leaves the session over its input limit.
    const first = await t.send('Reply with exactly the text "first ping" and nothing else.');
    first.expectOk();

    // The next turn must park on the harness-authored prompt before any
    // model call happens.
    await t.send('Reply with exactly the text "limit pong" and nothing else.');
    const request = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });

    const resumed = await t.respond({ optionId: "continue", requestId: request.requestId });
    resumed.expectOk();
    t.succeeded();
    t.messageIncludes("limit pong");

    const stopSession = t.newSession();
    const stopFirst = await stopSession.send(
      'Reply with exactly the text "stop ping" and nothing else.',
    );
    stopFirst.expectOk();

    await stopSession.send('Reply with exactly the text "stop pong" and nothing else.');
    const stopRequest = stopSession.requireInputRequest({
      display: "confirmation",
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });

    const stopped = await stopSession.respond({
      optionId: "stop",
      requestId: stopRequest.requestId,
    });
    stopped.expectOk();
    stopSession.notEvent("turn.failed");
    stopSession.notEvent("session.failed");
    stopSession.notEvent("session.completed");
    stopSession.event("turn.cancelled");
    t.check(stopped.status, equals("waiting"));
  },
});
