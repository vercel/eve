import { type JSONValue, type ToolSet, tool } from "ai";

import type { SessionCapabilities } from "#channel/types.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { ASK_QUESTION_TOOL_NAME } from "#runtime/framework-tools/ask-question.js";
import { WEB_SEARCH_TOOL_DEFINITION } from "#runtime/framework-tools/web-search.js";
import { isObject } from "#shared/guards.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveWebSearchBackend, resolveWebSearchProviderTool } from "#harness/provider-tools.js";
import type { HarnessToolMap } from "#harness/types.js";
import { loadContext } from "#context/container.js";
import {
  authorizationPendingModelText,
  isAuthorizationPendingModelOutput,
  isAuthorizationSignal,
  modelFacingAuthorizationOutput,
} from "#harness/authorization.js";
import { stashToolInterrupt } from "#harness/tool-interrupts.js";
import { isCodeModeToolExecutionOptions } from "#runtime/framework-tools/code-mode-connection-auth.js";

/**
 * Builds an AI SDK `ToolSet` from unified harness tool definitions.
 *
 * Tools without `execute` are surfaced to the model as client-side tools
 * (no server execution).
 *
 * The framework's `ask_question` tool is only exposed to the model when
 * {@link SessionCapabilities.requestInput} is `true`. Sessions without
 * the HITL capability (scheduled task roots and any subagent chain
 * descending from one) never see the tool.
 *
 * Entries listed in `disabledProviderTools` are skipped entirely. Used
 * by the harness recovery path when a gateway fallback provider has
 * rejected a provider-specific tool — the tool is dropped for the
 * retry call so the request can proceed without it.
 */
export function buildToolSet(input: {
  readonly approvedTools?: ReadonlySet<string>;
  readonly capabilities?: SessionCapabilities;
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly tools: HarnessToolMap;
}): ToolSet {
  const tools: Record<string, ToolSet[string]> = {};
  const canRequestInput = input.capabilities?.requestInput === true;
  const disabled = input.disabledProviderTools;

  for (const definition of input.tools.values()) {
    if (definition.name === ASK_QUESTION_TOOL_NAME && !canRequestInput) {
      continue;
    }

    if (disabled?.has(definition.name)) {
      continue;
    }

    const authorToModelOutput = definition.toModelOutput;
    tools[definition.name] = tool({
      description: definition.description,
      execute: wrapToolExecute(definition),
      inputSchema: definition.inputSchema,
      needsApproval: buildNeedsApprovalFn(definition, input),
      outputSchema: definition.outputSchema,
      ...(definition.execute !== undefined
        ? {
            toModelOutput: ({ output }: { output: unknown }) => {
              if (isAuthorizationPendingModelOutput(output)) {
                return {
                  type: "text" as const,
                  value: authorizationPendingModelText(output.connections),
                };
              }
              if (authorToModelOutput !== undefined) {
                return authorToModelOutput(output) as
                  | { type: "text"; value: string }
                  | { type: "json"; value: JSONValue };
              }
              if (typeof output === "string") {
                return { type: "text" as const, value: output };
              }
              return { type: "json" as const, value: (output ?? null) as JSONValue };
            },
          }
        : authorToModelOutput !== undefined
          ? {
              toModelOutput: ({ output }: { output: unknown }) =>
                authorToModelOutput(output) as
                  | { type: "text"; value: string }
                  | { type: "json"; value: JSONValue },
            }
          : {}),
    });
  }

  return tools as ToolSet;
}

/**
 * Builds a ToolSet from an ordered list of harness definitions.
 *
 * The first definition for a name wins, matching the dynamic-tool scope
 * ordering where step tools override turn/session tools.
 */
export function buildToolSetFromDefinitions(input: {
  readonly approvedTools?: ReadonlySet<string>;
  readonly capabilities?: SessionCapabilities;
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly tools: readonly HarnessToolDefinition[];
}): ToolSet {
  const tools = new Map<string, HarnessToolDefinition>();
  for (const definition of input.tools) {
    if (!tools.has(definition.name)) {
      tools.set(definition.name, definition);
    }
  }
  return buildToolSet({
    approvedTools: input.approvedTools,
    capabilities: input.capabilities,
    disabledProviderTools: input.disabledProviderTools,
    tools,
  });
}

/**
 * Wraps a tool's `execute` so a returned {@link AuthorizationSignal} is
 * stashed out-of-band ({@link stashToolInterrupt}) for the park detector while
 * the AI SDK records an opaque {@link AuthorizationPendingModelOutput} that
 * omits OAuth URLs, user codes, and hook URLs from model-facing history.
 *
 * Code-mode host executions consume the raw signal directly (see
 * `harness/code-mode.ts`) and their output is not a model-facing tool result,
 * so they pass through untouched. Returns `undefined` for client-side tools
 * (no `execute`).
 */
export function wrapToolExecute(
  definition: HarnessToolDefinition,
): ((input: any, options: { readonly toolCallId: string }) => Promise<any>) | undefined {
  const execute = definition.execute;
  if (execute === undefined) return undefined;
  return async (input, options) => {
    const output = await execute(input);
    if (!isAuthorizationSignal(output)) return output;
    if (isCodeModeToolExecutionOptions(options)) return output;
    stashToolInterrupt(loadContext(), options.toolCallId, output);
    return modelFacingAuthorizationOutput(output);
  };
}

/**
 * Builds the AI SDK ToolSet for one harness step.
 *
 * Most tools have local executors and are assembled by {@link buildToolSet}.
 * Provider-managed tools (e.g. web_search) have no local `execute` — the
 * execution layer intentionally omits it. This function detects the gap and
 * injects the real AI SDK provider tool in their place.
 * If the current model cannot supply that provider tool, the framework
 * sentinel is removed instead of being exposed as an unexecutable tool.
 *
 * When a user overrides a provider-managed tool via `defineTool()`, their
 * tool has a real executor and flows through the normal path — no
 * replacement occurs.
 *
 * Tool names listed in `disabledProviderTools` are skipped entirely —
 * both the framework definition and the injected provider tool are
 * omitted from the returned set. Used by the harness recovery path when
 * a gateway fallback provider has rejected a provider-specific tool.
 */
export async function buildToolSetWithProviderTools(input: {
  readonly approvedTools?: ReadonlySet<string>;
  readonly capabilities?: SessionCapabilities;
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly modelReference: RuntimeModelReference;
  readonly tools: HarnessToolMap;
}): Promise<ToolSet> {
  const disabled = input.disabledProviderTools;
  const tools: ToolSet = {
    ...buildToolSet({
      approvedTools: input.approvedTools,
      capabilities: input.capabilities,
      disabledProviderTools: disabled,
      tools: input.tools,
    }),
  };

  // Inject the real provider tool for web_search when the definition has
  // no local execute (i.e. the framework definition uses the provider sentinel).
  if (!disabled?.has(WEB_SEARCH_TOOL_DEFINITION.name)) {
    const webSearchTool = input.tools.get(WEB_SEARCH_TOOL_DEFINITION.name);
    if (webSearchTool !== undefined && webSearchTool.execute === undefined) {
      const backend = resolveWebSearchBackend(input.modelReference);
      if (backend === null) {
        delete tools[WEB_SEARCH_TOOL_DEFINITION.name];
      } else {
        tools[WEB_SEARCH_TOOL_DEFINITION.name] = await resolveWebSearchProviderTool(backend);
      }
    }
  }

  return tools;
}

function buildNeedsApprovalFn(
  definition: HarnessToolDefinition,
  input: { readonly approvedTools?: ReadonlySet<string> },
): (toolInput: unknown) => Promise<boolean> {
  return async (toolInput: unknown) => {
    if (definition.needsApproval === undefined) return false;

    const toolInputRecord = isObject(toolInput) ? toolInput : undefined;

    return definition.needsApproval({
      approvedTools: input.approvedTools ?? new Set(),
      toolInput: toolInputRecord,
      toolName: definition.name,
    });
  };
}
