import type { EveEvalContext } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { SURVEY_WORKER_INPUT_TOKENS } from "../constants";

/**
 * A delegated agent's spend counts against the session that delegated to it.
 * Alice asks for a tide survey, and the parent hands it to survey-worker. The
 * worker's one model call reports more input tokens than the parent's default
 * session budget, so the parent's next model call stops at its own
 * session-limit prompt, whose used figure includes the worker's tokens.
 * Approving the prompt lets the parent report the survey, and the parent's
 * `session.waiting` usage then includes the worker's tokens. Returns the session
 * for checks on how the parent delegated.
 */
export async function expectSurveyCountedAgainstParent(t: EveEvalContext, message: string) {
  const { session } = await t.send(message);
  const request = session.requireInputRequest({
    display: "confirmation",
    optionIds: ["continue", "stop"],
    toolName: "session_limit_continuation",
  });
  const parentLimitId = new RegExp(`^${session.sessionId ?? ""}:\\d+:limit:input:(\\d+)$`, "u");
  await t.require(
    request.requestId,
    satisfies(
      (requestId: string) =>
        Number(parentLimitId.exec(requestId)?.[1] ?? -1) >= SURVEY_WORKER_INPUT_TOKENS,
      "the parent's input limit prompt counts the worker's tokens",
    ),
  );

  const resumed = await session.respond([{ optionId: "continue", requestId: request.requestId }]);
  resumed.expectOk();
  resumed.messageIncludes("SURVEY-REPLY Alice's tide survey has 12 stations.");
  t.eventsSatisfy("the parent's recorded usage counts the worker's tokens", (events) => {
    // A delegated call's spend is recorded against the call that delegated it.
    const delegated = events.reduce(
      (total, event) =>
        event.type === "usage.recorded" &&
        event.data.owner !== undefined &&
        "callId" in event.data.owner
          ? total + event.data.usage.inputTokens
          : total,
      0,
    );
    return delegated >= SURVEY_WORKER_INPUT_TOKENS;
  });
  return session;
}
