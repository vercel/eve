import type { SessionAuthContext } from "#channel/types.js";
import type { StepInput } from "#harness/types.js";
import { readAnswerText } from "#internal/input-text.js";

import type { Intake } from "./index.js";

/**
 * What arrived for a turn's step, as the intakes human input reads, in the
 * order it reads them. Answers always count; a message counts only while the
 * turn waits on a person, since otherwise it is the turn's next input.
 */
export function arrivalsOf(input: {
  readonly held: boolean;
  /** Who the turn runs as, the sender of answers that name no one else. */
  readonly sender: SessionAuthContext | null;
  readonly stepInput: StepInput | undefined;
}): Intake[] {
  const { sender, stepInput } = input;
  const intakes: Intake[] = [];
  const responses = stepInput?.inputResponses ?? [];
  if (responses.length > 0) intakes.push({ responder: sender, responses, type: "answered" });
  for (const attributed of stepInput?.attributedInputResponses ?? []) {
    intakes.push({
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
