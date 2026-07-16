import type { LanguageModel, ToolSet } from "ai";

import {
  copyToolActivation,
  getToolActivation,
  type HarnessToolActivation,
  type ToolActivationProjection,
} from "#harness/tool-activation.js";

/** Provider transport used to place loaded definitions after their result. */
export type ToolActivationTransport = "anthropic-tool-reference" | "eager";

/** Resolves the transport supported by the active model adapter. */
export function resolveToolActivationTransport(model: LanguageModel): ToolActivationTransport {
  // The AI SDK request protocol used by eve cannot express OpenAI's positional
  // `additional_tools` item through either the direct adapter or Gateway.
  // Native OpenAI `tool_search` is not an equivalent fallback because its
  // `{ tools }` output would discard the existing connection summaries and
  // partial errors.
  if (typeof model === "string") return "eager";
  if (typeof model.provider !== "string" || typeof model.modelId !== "string") return "eager";

  const provider = model.provider.toLowerCase().split(".")[0];
  if (provider !== "anthropic") return "eager";

  return supportsAnthropicToolSearch(model.modelId) ? "anthropic-tool-reference" : "eager";
}

/** Applies provider-native loading semantics to activation-marked tools. */
export function applyProviderToolActivations(input: {
  readonly model: LanguageModel;
  readonly tools: ToolSet;
}): ToolSet {
  const entries = Object.entries(input.tools);
  const loaderIds = new Set(
    entries.flatMap(([, tool]) => {
      const activation = getToolActivation(tool);
      return activation?.kind === "loader" ? [activation.id] : [];
    }),
  );
  if (loaderIds.size === 0) return input.tools;
  if (resolveToolActivationTransport(input.model) === "eager") return input.tools;

  const result: Record<string, ToolSet[string]> = {};
  for (const [name, tool] of entries) {
    const activation = getToolActivation(tool);
    if (activation === undefined || !loaderIds.has(activation.id)) {
      result[name] = tool;
      continue;
    }

    result[name] =
      activation.kind === "loader"
        ? buildAnthropicLoader(tool, activation)
        : buildAnthropicDeferredTarget(tool);
  }

  return result as ToolSet;
}

function supportsAnthropicToolSearch(modelId: string): boolean {
  const match = /^claude-[a-z]+-(\d+)(?:[.-](\d+))?/.exec(modelId.toLowerCase());
  if (match === null) return false;

  const major = Number(match[1]);
  const minor = match[2] === undefined ? undefined : Number(match[2]);
  return major > 4 || (major === 4 && minor !== undefined && minor >= 5);
}

type ToolModelOutputInput = {
  readonly output: unknown;
  readonly toolCallId?: string;
};

type ToolWithModelOutput = ToolSet[string] & {
  readonly toModelOutput?: (input: ToolModelOutputInput) => unknown | Promise<unknown>;
};

function buildAnthropicLoader(
  tool: ToolSet[string],
  activation: Extract<HarnessToolActivation, { readonly kind: "loader" }>,
): ToolSet[string] {
  const source = tool as ToolWithModelOutput;
  const originalToModelOutput = source.toModelOutput;
  const adapted = {
    ...source,
    async toModelOutput(input: ToolModelOutputInput) {
      const ordinaryOutput =
        originalToModelOutput === undefined
          ? defaultToolModelOutput(input.output)
          : await originalToModelOutput(input);
      const projection = activation.project(input.output);
      return addAnthropicToolReferences(ordinaryOutput, projection);
    },
  } as ToolSet[string];
  return copyToolActivation(tool, adapted);
}

function buildAnthropicDeferredTarget(tool: ToolSet[string]): ToolSet[string] {
  const source = tool as ToolSet[string] & {
    readonly providerOptions?: Readonly<Record<string, unknown>>;
  };
  const anthropic = asRecord(source.providerOptions?.anthropic);
  const adapted = {
    ...source,
    providerOptions: {
      ...source.providerOptions,
      anthropic: {
        ...anthropic,
        deferLoading: true,
      },
    },
  } as ToolSet[string];
  return copyToolActivation(tool, adapted);
}

function addAnthropicToolReferences(
  ordinaryOutput: unknown,
  projection: ToolActivationProjection,
): unknown {
  const names = [...new Set(projection.tools.map((tool) => tool.name))];
  if (names.length === 0) return ordinaryOutput;

  const content = toContentParts(ordinaryOutput);
  if (content === null) return ordinaryOutput;

  return {
    type: "content" as const,
    value: [
      ...content,
      ...names.map((toolName) => ({
        providerOptions: {
          anthropic: {
            toolName,
            type: "tool-reference" as const,
          },
        },
        type: "custom" as const,
      })),
    ],
  };
}

function defaultToolModelOutput(output: unknown): unknown {
  return typeof output === "string"
    ? { type: "text" as const, value: output }
    : { type: "json" as const, value: output ?? null };
}

function toContentParts(output: unknown): readonly unknown[] | null {
  const record = asRecord(output);
  if (record === undefined) return null;

  if (record.type === "content" && Array.isArray(record.value)) {
    return record.value;
  }
  if (record.type === "text" && typeof record.value === "string") {
    return [{ text: record.value, type: "text" as const }];
  }
  if (record.type === "json") {
    return [{ text: JSON.stringify(record.value), type: "text" as const }];
  }
  return null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
