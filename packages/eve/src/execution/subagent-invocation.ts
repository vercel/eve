import type { StepInput } from "#harness/types.js";

/**
 * Narrowed form of {@link StepInput} whose `message` is always a plain string.
 * Delegated child runs receive a synthesized text-only prompt.
 */
export interface FormattedSubagentInvocation extends StepInput {
  readonly message: string;
}

type RuntimeSubagentInputFormatRequest = {
  readonly message: string;
  readonly name: string;
  readonly type: "runtime";
};

type LocalSubagentInputFormatRequest = {
  readonly description: string;
  readonly message: string;
  readonly name: string;
  readonly type: "local";
};

type RemoteSubagentInputFormatRequest = {
  readonly description: string;
  readonly message: string;
  readonly name: string;
  readonly type: "remote";
};

type SubagentInputFormatRequest =
  | RuntimeSubagentInputFormatRequest
  | LocalSubagentInputFormatRequest
  | RemoteSubagentInputFormatRequest;

type SubagentInputFormatters = {
  readonly runtime: (input: RuntimeSubagentInputFormatRequest) => FormattedSubagentInvocation;
  readonly local: (input: LocalSubagentInputFormatRequest) => FormattedSubagentInvocation;
  readonly remote: (input: RemoteSubagentInputFormatRequest) => FormattedSubagentInvocation;
};

const formatSubagentInputByType = {
  runtime(input) {
    return formatSubagentPrompt({
      descriptionLines: [],
      message: input.message,
      name: input.name,
    });
  },
  local(input) {
    return formatSubagentPrompt({
      descriptionLines: formatDescriptionLines(input.description),
      message: input.message,
      name: input.name,
    });
  },
  remote(input) {
    return formatSubagentPrompt({
      descriptionLines: formatDescriptionLines(input.description),
      message: input.message,
      name: input.name,
    });
  },
} satisfies SubagentInputFormatters;

/**
 * Formats the stable delegated input handed to one child agent invocation.
 */
export function formatSubagentInput(
  input: SubagentInputFormatRequest,
): FormattedSubagentInvocation {
  switch (input.type) {
    case "runtime":
      return formatSubagentInputByType.runtime(input);
    case "local":
      return formatSubagentInputByType.local(input);
    case "remote":
      return formatSubagentInputByType.remote(input);
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}

function formatSubagentPrompt(input: {
  readonly descriptionLines: readonly string[];
  readonly message: string;
  readonly name: string;
}): FormattedSubagentInvocation {
  return {
    message: [
      `You are the subagent "${input.name}".`,
      ...input.descriptionLines,
      "",
      "The caller delegated the following task to you. Complete it and return the final result directly.",
      "",
      "Caller message:",
      input.message,
    ].join("\n"),
  };
}

function formatDescriptionLines(description: string): readonly string[] {
  return description.trim().length > 0 ? [`Description: ${description}`] : [];
}
