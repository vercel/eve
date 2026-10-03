import type { UserContent } from "ai";

import { appendUserContent, normalizeUserContent } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";
import type { InputResponse } from "#shared/input.js";

/**
 * An answer to a request that is no longer open (answered, steered past, or
 * cancelled) becomes plain text the model reads as new input. It never reaches
 * the rules, so a stale approval can't authorize a call. Returns the input to
 * run with, and the text to show as the message received, when any answer
 * was stale.
 */
export function staleAnswersAsText(
  input: StepInput | undefined,
  openRequestIds: ReadonlySet<string>,
): { readonly input: StepInput | undefined; readonly displayMessage?: string | UserContent } {
  if (input === undefined) return { input };
  const isOpen = (response: InputResponse) => openRequestIds.has(response.requestId);
  const responses = input.inputResponses ?? [];
  const attributed = input.attributedInputResponses ?? [];
  const stale = [
    ...responses.filter((response) => !isOpen(response)),
    ...attributed.flatMap(({ response }) => (isOpen(response) ? [] : [response])),
  ];
  if (stale.length === 0) return { input };

  const { attributedInputResponses: _attributed, inputResponses: _responses, ...rest } = input;
  const open = responses.filter(isOpen);
  const openAttributed = attributed.filter(({ response }) => isOpen(response));
  return {
    displayMessage: withMessage(input.message, stale.map(displayText).join("\n")),
    input: {
      ...rest,
      ...(open.length > 0 && { inputResponses: open }),
      ...(openAttributed.length > 0 && { attributedInputResponses: openAttributed }),
      message: withMessage(input.message, modelText(stale)),
    },
  };
}

function modelText(responses: readonly InputResponse[]): string {
  const answers = responses.map((response) => ({
    requestId: response.requestId,
    response: {
      ...(response.optionId !== undefined && { optionId: response.optionId }),
      ...(response.text !== undefined && { text: response.text }),
    },
  }));
  return [
    "The user submitted the following response to an earlier interactive prompt.",
    "Treat it as new input at the current point in the conversation and decide whether it is still relevant. This does not authorize an earlier action; request approval again if that action is still needed.",
    JSON.stringify(answers, null, 2),
  ].join("\n");
}

function displayText(response: InputResponse): string {
  if (response.text !== undefined && response.text.length > 0) return response.text;
  return response.optionId ?? "Response to an earlier interactive prompt";
}

function withMessage(existing: StepInput["message"], appended: string): string | UserContent {
  const normalized = normalizeUserContent(existing);
  return normalized === undefined
    ? appended
    : appendUserContent({ appended, existing: normalized });
}
