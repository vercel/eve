import type { MessageContent } from "#shared/message-content.js";
import type { StepInput } from "#harness/types.js";
import type { SessionParent, SessionTraceSeed, SessionTraceRoot } from "#channel/types.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import { isJsonObjectValue, type JsonObject, type JsonValue } from "#shared/json.js";

export interface SubagentParentContext {
  readonly conversationId?: string;
  readonly lineage: SessionParent;
  /** The caller's trace root, which a local child inherits. */
  readonly traceRoot?: SessionTraceRoot;
  readonly continuationToken?: string;
  readonly traceContext?: SessionTraceSeed;
  readonly originAudience?: ChannelAudience;
}

/**
 * Delegated input keeps file parts beside the synthesized child instructions.
 */
interface FormattedSubagentInvocation extends StepInput {
  readonly message: MessageContent<string | URL>;
}

/**
 * Reads the `outputSchema` a `ctx.agent()` call requested. An empty `{}`
 * constrains nothing, but honoring it would flip the child into
 * structured-output mode and discard its text reply, so only a non-empty
 * object counts as a requested schema.
 */
export function normalizeRequestedOutputSchema(
  outputSchema: JsonValue | undefined,
): JsonObject | undefined {
  return isJsonObjectValue(outputSchema) && Object.keys(outputSchema).length > 0
    ? outputSchema
    : undefined;
}

type RuntimeSubagentInputFormatRequest = {
  readonly message: MessageContent<string | URL>;
  readonly name: string;
  readonly type: "runtime";
};

type LocalSubagentInputFormatRequest = {
  readonly description: string;
  readonly message: MessageContent<string | URL>;
  readonly name: string;
  readonly type: "local";
};

type RemoteSubagentInputFormatRequest = {
  readonly description: string;
  readonly message: MessageContent<string | URL>;
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
  readonly message: MessageContent<string | URL>;
  readonly name: string;
}): FormattedSubagentInvocation {
  const prompt = [
    `You are the subagent "${input.name}".`,
    ...input.descriptionLines,
    "",
    "The caller delegated the following task to you. Complete it and return the result directly. The caller may send follow-up messages after you answer.",
    "",
    "Caller message:",
    ...(typeof input.message === "string" ? [input.message] : []),
  ].join("\n");
  return {
    message:
      typeof input.message === "string"
        ? prompt
        : [{ type: "text", text: prompt }, ...input.message],
  };
}

function formatDescriptionLines(description: string): readonly string[] {
  return description.trim().length > 0 ? [`Description: ${description}`] : [];
}
