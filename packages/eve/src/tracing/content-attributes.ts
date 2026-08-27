/**
 * Which span attributes carry conversation content, and in which direction.
 *
 * Two vocabularies land on the same spans: the ones eve sets on its own
 * `agent.*` spans, and the ones the AI SDK's OpenTelemetry integration sets on
 * the model-call spans beneath them. A destination that declined content has to
 * be rid of both, so both are listed here rather than in the module that writes
 * each.
 *
 * Listed by name rather than by prefix because the prefixes are shared with
 * metadata that must survive: `ai.response.finish_reason` and
 * `gen_ai.tool.name` say what happened, not what was said. The cost is that a
 * new content attribute in a dependency is not covered until it is added here.
 */

/** Prompts, instructions, tool arguments — what went in. */
const INPUT_CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "agent.channel.delivery.input",
  "agent.approval.request",
  "ai.documents",
  "ai.prompt",
  "ai.prompt.messages",
  "ai.prompt.system",
  "ai.prompt.toolChoice",
  "ai.prompt.tools",
  "ai.value",
  "ai.values",
  "gen_ai.input.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.definitions",
]);

/**
 * Responses, reasoning, tool results — what came out.
 *
 * `ai.toolCall.args` is here rather than above because the AI SDK gates it on
 * `recordOutputs`; matching that is what keeps one destination's view coherent.
 */
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
  "gen_ai.output.messages",
  "gen_ai.tool.call.result",
]);

/** What one destination is willing to receive. */
export interface ResolvedContentOptions {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

function isDeclined(key: string, content: ResolvedContentOptions): boolean {
  if (!content.recordInputs && INPUT_CONTENT_ATTRIBUTES.has(key)) return true;
  return !content.recordOutputs && OUTPUT_CONTENT_ATTRIBUTES.has(key);
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
  if (!keys.some((key) => isDeclined(key, content))) return undefined;

  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    if (!isDeclined(key, content)) kept[key] = attributes[key];
  }
  return kept;
}
