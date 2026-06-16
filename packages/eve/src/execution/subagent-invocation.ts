import type { StepInput } from "#harness/types.js";

/**
 * Narrowed form of {@link StepInput} whose `message` is always a plain string.
 * Delegated child runs receive a synthesized text-only prompt.
 */
export interface FormattedSubagentInvocation extends StepInput {
  readonly message: string;
}

/**
 * Formats the stable delegated input handed to one child agent invocation.
 */
export function formatSubagentInvocation(input: {
  readonly description: string;
  readonly message: string;
  readonly name: string;
}): FormattedSubagentInvocation {
  return {
    message: [
      `You are the subagent "${input.name}".`,
      `Description: ${input.description}`,
      "",
      "The caller delegated the following task to you. Complete it and return the final result directly.",
      "",
      "Caller message:",
      input.message,
    ].join("\n"),
  };
}
