import type { StepInput } from "#harness/types.js";
import { isJsonObjectValue, type JsonObject, type JsonValue } from "#shared/json.js";

/**
 * Narrowed form of {@link StepInput} whose `message` is always a plain string.
 * Delegated child runs receive a synthesized text-only prompt.
 */
export interface FormattedSubagentInvocation extends StepInput {
  readonly message: string;
}

/**
 * Normalizes the `outputSchema` a model passed on a subagent tool call.
 * Models routinely send an empty `{}` despite the tool schema saying to omit
 * it; an empty JSON Schema constrains nothing, but honoring it flips the
 * child into structured-output mode and discards its text reply. Only a
 * non-empty object counts as a requested schema — local and remote dispatch
 * share this rule.
 */
export function normalizeRequestedOutputSchema(
  outputSchema: JsonValue | undefined,
): JsonObject | undefined {
  return isJsonObjectValue(outputSchema) && Object.keys(outputSchema).length > 0
    ? outputSchema
    : undefined;
}

type RuntimeSubagentInputFormatRequest = {
  readonly message: string;
  readonly name: string;
  readonly persistentSession?: boolean;
  readonly type: "runtime";
};

type LocalSubagentInputFormatRequest = {
  readonly description: string;
  readonly message: string;
  readonly name: string;
  readonly persistentSession?: boolean;
  readonly type: "local";
};

type RemoteSubagentInputFormatRequest = {
  readonly description: string;
  readonly message: string;
  readonly name: string;
  readonly persistentSession?: boolean;
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
      persistentSession: input.persistentSession,
    });
  },
  local(input) {
    return formatSubagentPrompt({
      descriptionLines: formatDescriptionLines(input.description),
      message: input.message,
      name: input.name,
      persistentSession: input.persistentSession,
    });
  },
  remote(input) {
    return formatSubagentPrompt({
      descriptionLines: formatDescriptionLines(input.description),
      message: input.message,
      name: input.name,
      persistentSession: input.persistentSession,
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
  readonly persistentSession?: boolean;
}): FormattedSubagentInvocation {
  return {
    message: [
      `You are the subagent "${input.name}".`,
      ...input.descriptionLines,
      "",
      input.persistentSession === true
        ? "The caller delegated the following task to you. Complete it and return the result directly. The caller may send follow-up messages after you answer."
        : "The caller delegated the following task to you. Complete it and return the final result directly.",
      "",
      "Caller message:",
      input.message,
    ].join("\n"),
  };
}

function formatDescriptionLines(description: string): readonly string[] {
  return description.trim().length > 0 ? [`Description: ${description}`] : [];
}
