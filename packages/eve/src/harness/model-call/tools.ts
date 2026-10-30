import type { ToolSet } from "ai";

import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import { SKILL_ENTRY_NAME } from "#protocol/catalog-tools.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { buildFinalOutputTool } from "#harness/final-output.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import type { ModelProfile } from "#harness/model-profile.js";
import { applyLastToolCacheBreakpoint } from "#harness/prompt-cache.js";
import type { Step } from "#harness/step/context.js";
import { buildToolSetWithProviderTools } from "#harness/tools.js";
import { toModelSchema } from "#tools/schema.js";

/**
 * Assembles the tools one model call offers: the catalog's listed entries with provider tools in
 * place, and `eve__reply` when the turn asks for a structured result.
 */
export async function prepareModelTools(
  step: Step,
  input: {
    readonly catalog: StepCatalog;
    readonly disabledProviderTools?: ReadonlySet<string>;
    readonly profile: ModelProfile;
  },
): Promise<ToolSet> {
  const { catalog, profile } = input;
  const modelTools = await buildToolSetWithProviderTools({
    describe: catalog.describe,
    disabledProviderTools: input.disabledProviderTools,
    profile,
    tools: catalog.advertised,
  });
  if (step.session.outputSchema !== undefined) {
    modelTools[REPLY_TOOL_NAME] = buildFinalOutputTool(step.session.outputSchema);
  }

  const effectiveTools = profile.anthropicCache
    ? applyLastToolCacheBreakpoint(modelTools, profile.anthropicCache)
    : modelTools;
  for (const tool of Object.values(effectiveTools)) {
    // Whatever produced this tool, the AI SDK must only receive its own
    // schema type; see toModelSchema.
    tool.inputSchema = toModelSchema(tool.inputSchema, "input");
    if (tool.outputSchema !== undefined) {
      tool.outputSchema = toModelSchema(tool.outputSchema, "output");
    }
  }
  return effectiveTools;
}

/** The entries that can end the turn, with their `endsTurn` option, when `endsTurn` applies. */
export function endsTurnTools(catalog: StepCatalog, applies: boolean): EndsTurnTools {
  if (!applies) return new Map();
  return new Map(
    [...catalog.entries].flatMap(([name, definition]) =>
      definition.endsTurn === undefined || definition.endsTurn === false
        ? []
        : [[name, definition.endsTurn] as const],
    ),
  );
}

/** The names of the entries eve provides, which tracing marks as framework tools. */
export function frameworkToolNames(catalog: StepCatalog): ReadonlySet<string> {
  return new Set(
    [
      ...catalog.advertised.values(),
      ...catalog.entries.values(),
      catalog.get(SKILL_ENTRY_NAME),
    ].flatMap((definition) => (definition?.frameworkTool === true ? [definition.name] : [])),
  );
}

export type EndsTurnTools = ReadonlyMap<string, NonNullable<HarnessToolDefinition["endsTurn"]>>;
