import type { MemoryDefinition, MemoryToolSet, MemoryToolsContext } from "#public/memory/index.js";
import { defineDynamic } from "#public/definitions/tool.js";
import { resolveApprovalPolicy } from "#public/definitions/approval.js";
import { loadContext } from "#context/container.js";
import { TurnMemoryLocksKey } from "#context/keys.js";
import { TOOL_SLUG_PATTERN } from "#discover/grammar.js";
import { markDynamicCallbackRebind } from "#internal/dynamic-tool-rebind.js";
import { isBrandedToolEntry } from "#shared/dynamic-tool-definition.js";
import { stampDurableDynamicToolCallbacks } from "#shared/durable-dynamic-tool-callbacks.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export function createMemoryToolDynamicDefinition(definition: MemoryDefinition, slot: string) {
  return markDynamicCallbackRebind(
    defineDynamic({
      events: {
        "turn.started": async (_event, resolveContext) => {
          const lock = loadContext().get(TurnMemoryLocksKey)?.[slot];
          if (
            lock === undefined ||
            definition.tools === false ||
            definition.provider.tools === undefined
          ) {
            return null;
          }
          const context: MemoryToolsContext = {
            ...resolveContext,
            memory: { scope: lock.scope, slot },
            turn: lock.turn,
          };
          const result = await definition.provider.tools(context);
          if (result === null) return null;
          if (typeof result !== "object" || Array.isArray(result)) {
            throw new Error(
              `Memory slot "${slot}" provider.tools() must return a tool map or null.`,
            );
          }
          return Object.fromEntries(
            Object.entries(result).map(([key, tool]) => {
              const name = `${slot}__${key}`;
              if (!TOOL_SLUG_PATTERN.test(name)) {
                throw new Error(
                  `Memory provider tool name "${name}" must start with an ASCII letter, contain only letters, digits, underscores, or dashes, and be at most 64 characters.`,
                );
              }
              if (!isBrandedToolEntry(tool)) {
                throw new Error(
                  `Memory provider tool "${name}" must be created with defineTool().`,
                );
              }
              const description =
                definition.description === undefined
                  ? tool.description
                  : `${definition.description}\n\n${tool.description}`;
              const qualified = { ...tool, description };
              stampDurableDynamicToolCallbacks(
                qualified,
                createProviderToolCallbacks({ context, definition, key, tool }),
              );
              return [name, qualified];
            }),
          );
        },
      },
    }),
  );
}

function createProviderToolCallbacks(input: {
  readonly context: MemoryToolsContext;
  readonly definition: MemoryDefinition;
  readonly key: string;
  readonly tool: MemoryToolSet[string];
}) {
  const closure = parseJsonObject({ context: input.context, key: input.key });
  const loadTool = async (rawClosure: JsonObject) => {
    const key = rawClosure.key;
    const context = rawClosure.context;
    if (typeof key !== "string" || typeof context !== "object" || context === null) {
      throw new Error("Memory provider tool callback has an invalid durable closure.");
    }
    const tools = await input.definition.provider.tools?.(readMemoryToolsContext(context));
    const tool = tools?.[key];
    if (tool === undefined || !isBrandedToolEntry(tool)) {
      throw new Error(`Memory provider tool "${key}" was removed or renamed.`);
    }
    return tool;
  };
  const callbacks: Parameters<typeof stampDurableDynamicToolCallbacks>[1] = {
    execute: {
      callback: async (rawClosure, toolInput, context) =>
        await (await loadTool(rawClosure)).execute(toolInput, context),
      closure,
    },
  };
  if (input.tool.approval !== undefined) {
    callbacks.approvalRequest = {
      callback: async (rawClosure, context) =>
        await resolveApprovalPolicy((await loadTool(rawClosure)).approval!)(context),
      closure,
    };
    if (typeof input.tool.approval !== "function" && input.tool.approval.response !== undefined) {
      callbacks.approvalResponse = {
        callback: async (rawClosure, context) => {
          const approval = (await loadTool(rawClosure)).approval;
          if (
            approval === undefined ||
            typeof approval === "function" ||
            approval.response === undefined
          ) {
            throw new Error(`Memory provider tool "${input.key}" approval response was removed.`);
          }
          return await approval.response(context);
        },
        closure,
      };
    }
  }
  if (input.tool.toModelOutput !== undefined) {
    callbacks.toModelOutput = {
      callback: async (rawClosure, output) =>
        await (
          await loadTool(rawClosure)
        ).toModelOutput!(output),
      closure,
    };
  }
  return callbacks;
}

function readMemoryToolsContext(value: unknown): MemoryToolsContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Memory provider tool callback has an invalid durable context.");
  }
  const candidate: unknown = value;
  const context = candidate as MemoryToolsContext;
  if (
    typeof context.channel !== "object" ||
    context.channel === null ||
    typeof context.memory !== "object" ||
    context.memory === null ||
    !Array.isArray(context.messages) ||
    typeof context.session !== "object" ||
    context.session === null ||
    typeof context.turn !== "object" ||
    context.turn === null
  ) {
    throw new Error("Memory provider tool callback has an invalid durable context.");
  }
  return context;
}
