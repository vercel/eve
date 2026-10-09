import type { HarnessStepInput } from "#harness/types.js";
import type { InputResponse } from "#shared/input.js";
import type { ResponseSubmittedData } from "#protocol/session-events/families/response.js";

/** The immutable delivery/response identity of an answer after input coalescing. */
export function responseBindingFor(
  input: HarnessStepInput | undefined,
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

/**
 * Binds answers a typed message resolved to the delivery that carried it, so they keep one
 * identity through coalescing and policy passes like a press does.
 */
export function withTypedBindings(
  input: HarnessStepInput,
  responses: readonly InputResponse[],
): readonly ResponseSubmittedData[] | undefined {
  const deliveryId = input.deliveries?.at(-1)?.deliveryId;
  if (deliveryId === undefined || responses.length === 0) return input.responseBindings;
  return [
    ...(input.responseBindings ?? []),
    ...responses.map((response, index) => {
      const value: { optionId?: string; text?: string } = {};
      if (response.optionId !== undefined) value.optionId = response.optionId;
      if (response.text !== undefined) value.text = response.text;
      return {
        deliveryId,
        interactionId: response.requestId,
        responseId: `response_${deliveryId}_typed_${String(index)}`,
        value,
      };
    }),
  ];
}
