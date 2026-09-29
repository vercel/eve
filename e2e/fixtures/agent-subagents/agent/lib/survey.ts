import { latestTaskResult, playScript } from "@eve-e2e/config/mock-script";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

import { SURVEY_DIRECTIVE, SURVEY_WORKER_INPUT_TOKENS } from "../../constants.js";

// The survey script: the parent starts one survey-worker task and waits for
// it. The worker's one model call reports more input tokens than the parent's
// whole session budget, so once the worker's usage counts against the parent,
// the parent's next model call stops at its own session-limit prompt.

/** Whether a message is Alice's survey request. */
export function isSurveyDirective(message: string): boolean {
  return message.startsWith(`${SURVEY_DIRECTIVE} `);
}

/** The parent: starts the survey, waits for it, and reports the worker's answer. */
export function respondAsSurveyParent(request: MockModelRequest): MockModelResponse | string {
  return playScript(
    request,
    [
      {
        id: "survey-start",
        input: () => ({ message: "Please count the tide survey stations for Alice." }),
        name: "survey-worker",
      },
      { id: "survey-wait", name: "task_wait" },
    ],
    (finished) => `SURVEY-REPLY ${latestTaskResult(finished, "survey-worker") ?? "no result"}`,
  );
}

/** The worker: answers in one model call that reports a large prompt. */
export function respondAsSurveyWorker(): MockModelResponse {
  return {
    text: "Alice's tide survey has 12 stations.",
    usage: { inputTokens: SURVEY_WORKER_INPUT_TOKENS, outputTokens: 20 },
  };
}
