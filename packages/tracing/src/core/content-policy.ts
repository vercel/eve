const INPUT_CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "agent.channel.delivery.input",
  "agent.session.title",
  "agent.approval.request",
  "ai.documents",
  "ai.prompt",
  "ai.prompt.toolChoice",
  "ai.prompt.tools",
  "ai.value",
  "ai.values",
  "gen_ai.input.messages",
  "gen_ai.memory.records",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.definitions",
]);

const OUTPUT_CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "agent.approval.response",
  "ai.embedding",
  "ai.embeddings",
  "ai.ranking",
  "ai.response.files",
  "ai.response.object",
  "ai.response.reasoning",
  "ai.response.text",
  "ai.response.toolCalls",
  "ai.response.tool_calls",
  "ai.response.tool_results",
  "ai.toolCall.args",
  "ai.toolCall.result",
  "gen_ai.decision.results",
  "gen_ai.extraction.results",
  "gen_ai.output.messages",
  "gen_ai.tool.call.result",
]);

const INPUT_POLICY_ATTRIBUTE = "agent.trace.content.input";
const OUTPUT_POLICY_ATTRIBUTE = "agent.trace.content.output";

/** What one destination is willing to receive. */
export interface ResolvedContentOptions {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

function isDeclined(key: string, content: ResolvedContentOptions): boolean {
  if (!content.recordInputs && INPUT_CONTENT_ATTRIBUTES.has(key)) return true;
  return !content.recordOutputs && OUTPUT_CONTENT_ATTRIBUTES.has(key);
}

function narrowsContentPolicy(
  attributes: Readonly<Record<string, unknown>>,
  content: ResolvedContentOptions,
): boolean {
  return (
    (!content.recordInputs && attributes[INPUT_POLICY_ATTRIBUTE] === true) ||
    (!content.recordOutputs && attributes[OUTPUT_POLICY_ATTRIBUTE] === true)
  );
}

function exportedAttributeValue(
  key: string,
  value: unknown,
  content: ResolvedContentOptions,
): unknown {
  if (key === INPUT_POLICY_ATTRIBUTE && value === true && !content.recordInputs) return false;
  if (key === OUTPUT_POLICY_ATTRIBUTE && value === true && !content.recordOutputs) return false;
  return value;
}

export function preservingCapturePolicy(
  attributes: Readonly<Record<string, unknown>>,
  original: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const kept = { ...attributes };
  for (const key of [INPUT_POLICY_ATTRIBUTE, OUTPUT_POLICY_ATTRIBUTE])
    if (key in original) kept[key] = original[key];
  return kept;
}

/**
 * The attributes with the declined content removed, or `undefined` when there
 * was none to remove.
 *
 * The `undefined` return is what lets the caller forward the original span
 * untouched in the common case, so a destination that declined a direction the
 * span never carried costs one pass over its keys and no allocation.
 */
export function withoutDeclinedContent(
  attributes: Readonly<Record<string, unknown>>,
  content: ResolvedContentOptions,
): Record<string, unknown> | undefined {
  const keys = Object.keys(attributes);
  if (!keys.some((key) => isDeclined(key, content)) && !narrowsContentPolicy(attributes, content)) {
    return undefined;
  }

  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    if (!isDeclined(key, content)) {
      kept[key] = exportedAttributeValue(key, attributes[key], content);
    }
  }
  return kept;
}
