import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

/**
 * Session token limits over HTTP: a conversation session that crosses its
 * input budget parks on the deterministic `session_limit_continuation`
 * prompt instead of failing, and answering "Continue" grants a fresh budget
 * window and processes the queued message.
 */
export default defineEval({
  description: "Session token limit parks on a continuation prompt; Continue resumes.",
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
    stopSession.succeeded();
    stopSession.notEvent("turn.failed");
    stopSession.event("session.completed");
    t.check(stopped.status, equals("completed"));
  },
});
