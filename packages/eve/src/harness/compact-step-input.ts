import type { StepInput } from "#harness/types.js";

type CompactableStepInput = StepInput & { readonly messageConsumed?: boolean };

/** Drops empty optional fields before a step input is persisted for replay. */
export function compactStepInput(input: CompactableStepInput | undefined): CompactableStepInput {
  if (input === undefined) {
    return {};
  }

  const result: { -readonly [K in keyof CompactableStepInput]?: CompactableStepInput[K] } = {};

  if ((input.clientContext?.length ?? 0) > 0) {
    result.clientContext = input.clientContext;
  }
  if ((input.context?.length ?? 0) > 0) {
    result.context = input.context;
  }
  if ((input.inputResponses?.length ?? 0) > 0) {
    result.inputResponses = input.inputResponses;
  }
  if (input.message !== undefined) {
    result.message = input.message;
  }
  if (input.messageConsumed === true) {
    result.messageConsumed = true;
  }
  if (input.outputSchema !== undefined) {
    result.outputSchema = input.outputSchema;
  }

  return result;
}
