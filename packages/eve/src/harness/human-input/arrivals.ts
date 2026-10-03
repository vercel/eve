import type { SessionAuthContext } from "#channel/types.js";
import type { ReceivedAuthorizationCallback } from "#harness/authorization.js";
import type { StepInput } from "#harness/types.js";
import { readAnswerText } from "#internal/input-text.js";

import type { Intake } from "./index.js";

/**
 * What arrived for a turn's step, as the intakes human input reads, in the
 * order it reads them. Answers always count; a message counts only while the
 * turn waits on a person, since otherwise it is the turn's next input.
 */
export function arrivalsOf(input: {
  readonly callbacks: readonly ReceivedAuthorizationCallback[];
  readonly held: boolean;
  readonly now: number;
  /** Who the turn runs as, the sender of answers that name no one else. */
  readonly sender: SessionAuthContext | null;
  readonly stepInput: StepInput | undefined;
}): Intake[] {
  const { now, sender, stepInput } = input;
  // Time goes first, so an answer that expired never runs its policy.
  const intakes: Intake[] = [{ now, type: "time" }];
  for (const { attemptId, callback, connectionName } of input.callbacks) {
    intakes.push(
      callback === undefined
        ? { attemptId, connectionName, outcome: "failed", type: "authorization.completed" }
        : {
            attemptId,
            callback,
            connectionName,
            outcome: "authorized",
            type: "authorization.completed",
          },
    );
  }
  const responses = stepInput?.inputResponses ?? [];
  if (responses.length > 0) intakes.push({ now, responder: sender, responses, type: "answered" });
  for (const attributed of stepInput?.attributedInputResponses ?? []) {
    intakes.push({
      now,
      responder: attributed.auth,
      responses: [attributed.response],
      type: "answered",
    });
  }
  if (stepInput?.message !== undefined && input.held) {
    intakes.push({
      sender: stepInput.messageAuth ?? sender,
      text: readAnswerText(stepInput) ?? "",
      type: "message",
    });
  }
  return intakes;
}
