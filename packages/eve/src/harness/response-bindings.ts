import type { StepInput } from "#harness/types.js";
import type { InputResponse } from "#shared/input.js";
import type { ResponseSubmittedData } from "#protocol/session-events/families/response.js";

/** The immutable delivery/response identity of an answer after input coalescing. */
export function responseBindingFor(
  input: StepInput | undefined,
  response: InputResponse,
): ResponseSubmittedData | undefined {
  return input?.responseBindings?.findLast(
    (binding) =>
      binding.interactionId === response.requestId &&
      binding.value?.text === response.text &&
      sameOption(binding.value?.optionId, response.optionId),
  );
}

function sameOption(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  // ACP's Deny and eve's Cancel are the same decision, without changing the submitted value.
  return (a === "deny" && b === "cancel") || (a === "cancel" && b === "deny");
}
