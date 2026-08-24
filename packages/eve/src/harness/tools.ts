import { type ToolApprovalConfiguration, type ToolApprovalStatus, type ToolSet, tool } from "ai";

import type { SessionCapabilities } from "#channel/types.js";
import {
  hasPreparedKernelCapability,
  type KernelCapabilityName,
  type KernelCapabilityPlan,
} from "#kernel/capabilities.js";
import { installKernelProviderTool } from "#kernel/executable-capabilities.js";
import { isObject } from "#shared/guards.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveApprovalPolicy, type ApprovalStatus } from "#public/definitions/approval.js";
import {
  resolveWebSearchProviderTool,
  type ModelProviderCapabilityAvailability,
} from "#harness/provider-tools.js";
import type { HarnessToolMap } from "#harness/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { loadContext } from "#context/container.js";
import {
  authorizationPendingModelText,
  isAuthorizationPendingModelOutput,
  isAuthorizationSignal,
  modelFacingAuthorizationOutput,
} from "#harness/authorization.js";
import { stashToolInterrupt } from "#harness/tool-interrupts.js";
import { normalizeToolJsonOutput, normalizeToolModelOutput } from "#harness/tool-model-output.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import {
  createBackgroundToolCallBatch,
  executeBackgroundToolCall,
  type BackgroundExecutableTool,
  type BackgroundToolCallBatch,
} from "#harness/background-tools.js";

type NativeApprovalStatus = Exclude<ApprovalStatus, boolean>;

const toolApprovals = new WeakMap<
  object,
  (toolInput: unknown, callId: string) => Promise<NativeApprovalStatus>
>();

/**
 * Builds an AI SDK `ToolSet` from unified harness tool definitions.
 *
 * Tools without `execute` are surfaced to the model as client-side tools
 * (no server execution).
 *
 */
export function buildToolSet(input: {
  readonly approvedTools?: ReadonlySet<string>;
  readonly backgroundBatch?: BackgroundToolCallBatch;
  readonly capabilities?: SessionCapabilities;
  readonly tools: HarnessToolMap;
}): ToolSet {
  const tools: Record<string, ToolSet[string]> = {};
  const backgroundBatch = input.backgroundBatch ?? createBackgroundToolCallBatch();

  for (const definition of input.tools.values()) {
    backgroundBatch.setTool(
      definition.name,
      definition.execution === "background" && definition.execute !== undefined
        ? (definition as BackgroundExecutableTool)
        : undefined,
    );
    const authorToModelOutput = definition.toModelOutput;
    const approval = buildApprovalFn(definition, input);
    const aiTool = tool({
      description: definition.description,
      execute: wrapToolExecute(definition, backgroundBatch),
      inputSchema: definition.inputSchema,
      ...(definition.execution === "background"
        ? {
            onInputAvailable: ({
              input: toolInput,
              toolCallId,
            }: {
              readonly input: unknown;
              readonly toolCallId: string;
            }) => {
              if (definition.execute === undefined) {
                throw new Error(`Background tool "${definition.name}" has no execute function.`);
              }
              backgroundBatch.register({
                callId: toolCallId,
                input: toolInput,
                toolName: definition.name,
              });
            },
          }
        : {}),
      outputSchema: definition.outputSchema,
      ...(definition.execute !== undefined
        ? {
            toModelOutput: async ({
              output,
              toolCallId,
            }: {
              readonly output: unknown;
              readonly toolCallId?: string;
            }) => {
              if (isAuthorizationPendingModelOutput(output)) {
                return {
                  type: "text" as const,
                  value: authorizationPendingModelText(output.connections),
                };
              }
              if (authorToModelOutput !== undefined) {
                return normalizeToolModelOutput({
                  output: await authorToModelOutput(output),
                  toolCallId,
                  toolName: definition.name,
                });
              }
              if (typeof output === "string") {
                return { type: "text" as const, value: output };
              }
              return normalizeToolModelOutput({
                output: { type: "json" as const, value: output ?? null },
                toolCallId,
                toolName: definition.name,
              });
            },
          }
        : authorToModelOutput !== undefined
          ? {
              toModelOutput: async ({
                output,
                toolCallId,
              }: {
                readonly output: unknown;
                readonly toolCallId?: string;
              }) =>
                normalizeToolModelOutput({
                  output: await authorToModelOutput(output),
                  toolCallId,
                  toolName: definition.name,
                }),
            }
          : {}),
    });
    tools[definition.name] = aiTool;
    if (definition.approval !== undefined) {
      toolApprovals.set(aiTool, approval);
    }
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
  readonly backgroundBatch?: BackgroundToolCallBatch;
  readonly capabilities?: SessionCapabilities;
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
    backgroundBatch: input.backgroundBatch,
    capabilities: input.capabilities,
    tools,
  });
}

/**
 * Wraps a tool's `execute` so a returned {@link AuthorizationSignal} is
 * stashed out-of-band ({@link stashToolInterrupt}) for the park detector while
 * the AI SDK records an opaque {@link AuthorizationPendingModelOutput} that
 * omits OAuth URLs, user codes, and hook URLs from model-facing history.
 * Returns `undefined` for client-side tools (no `execute`).
 */
export function wrapToolExecute(
  definition: HarnessToolDefinition,
  backgroundBatch: BackgroundToolCallBatch = createBackgroundToolCallBatch(),
): ((input: any, options: ToolExecuteOptions) => Promise<any> | AsyncIterable<any>) | undefined {
  const execute = definition.execute;
  if (execute === undefined) return undefined;

  return (input, options) => {
    let output: unknown;
    try {
      output =
        definition.execution === "background"
          ? executeBackgroundToolCall({
              batch: backgroundBatch,
              definition: definition as BackgroundExecutableTool,
              options,
              toolInput: input,
            })
          : execute(input, options);
    } catch (error) {
      return Promise.reject(error);
    }

    if (isAsyncIterable(output)) {
      return normalizeToolExecuteIterable(output, definition.name, options);
    }

    return Promise.resolve(output).then((value) =>
      normalizeToolExecuteOutput(value, definition.name, options),
    );
  };
}

async function* normalizeToolExecuteIterable(
  output: AsyncIterable<unknown>,
  toolName: string,
  options: ToolExecuteOptions,
): AsyncIterable<unknown> {
  for await (const value of output) {
    yield normalizeToolExecuteOutput(value, toolName, options);
  }
}

function normalizeToolExecuteOutput(
  output: unknown,
  toolName: string,
  options: ToolExecuteOptions,
): unknown {
  if (isAuthorizationSignal(output)) {
    stashToolInterrupt(loadContext(), options.toolCallId, output);
    return modelFacingAuthorizationOutput(output);
  }
  return normalizeToolJsonOutput({
    boundary: "execute",
    output,
    toolCallId: options.toolCallId,
    toolName,
  });
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
 * Capabilities listed in `disabledProviderCapabilities` omit only the
 * kernel-owned provider injection. Same-named authored tools remain ordinary
 * definitions and cannot be removed by provider recovery.
 */
export interface BuiltToolSetWithProviderCapabilities {
  readonly installedProviderCapabilities: ReadonlySet<KernelCapabilityName>;
  readonly tools: ToolSet;
}

export async function buildToolSetWithProviderTools(input: {
  readonly approvedTools?: ReadonlySet<string>;
  readonly backgroundBatch?: BackgroundToolCallBatch;
  readonly capabilities?: SessionCapabilities;
  readonly disabledProviderCapabilities?: ReadonlySet<KernelCapabilityName>;
  readonly kernelPlan: KernelCapabilityPlan;
  readonly providerAvailability: ModelProviderCapabilityAvailability;
  readonly tools: HarnessToolMap;
}): Promise<BuiltToolSetWithProviderCapabilities> {
  const disabled = input.disabledProviderCapabilities;
  const { modelSupportsProviderTools, webSearchBackend } = input.providerAvailability;
  const tools: ToolSet = {
    ...buildToolSet({
      approvedTools: input.approvedTools,
      backgroundBatch: input.backgroundBatch,
      capabilities: input.capabilities,
      tools: input.tools,
    }),
  };
  const installedProviderCapabilities = new Set<KernelCapabilityName>();

  for (const definition of input.tools.values()) {
    const name = definition.kernelCapability;
    if (name === undefined || definition.execute !== undefined) {
      continue;
    }
    if (disabled?.has(name)) {
      delete tools[definition.name];
      continue;
    }

    const decision = await installKernelProviderTool(name, {
      installWebSearch: async () => {
        if (webSearchBackend === null) {
          throw new Error("Web search provider installation requires a supported model backend.");
        }
        return await resolveWebSearchProviderTool(webSearchBackend);
      },
      modelSupportsProviderTools:
        hasPreparedKernelCapability(input.kernelPlan, name) && modelSupportsProviderTools,
    });
    if (!decision.handled) continue;
    if (decision.tool === undefined) {
      delete tools[definition.name];
    } else {
      tools[definition.name] = decision.tool;
      installedProviderCapabilities.add(name);
    }
  }

  return { installedProviderCapabilities, tools };
}

function buildApprovalFn(
  definition: HarnessToolDefinition,
  input: { readonly approvedTools?: ReadonlySet<string> },
): (toolInput: unknown, callId: string) => Promise<NativeApprovalStatus> {
  return async (toolInput: unknown, callId: string) => {
    if (definition.approval === undefined) return undefined;

    const toolInputRecord = isObject(toolInput) ? toolInput : undefined;

    const status = await resolveApprovalPolicy(definition.approval)({
      ...buildCallbackContext(),
      approvedTools: input.approvedTools ?? new Set(),
      callId,
      toolInput: toolInputRecord,
      toolName: definition.name,
    });
    return typeof status === "boolean" ? (status ? "user-approval" : "not-applicable") : status;
  };
}

/** Builds the AI SDK 7 call-level approval policy for an assembled tool set. */
export function buildToolApproval(
  tools: ToolSet,
): ToolApprovalConfiguration<ToolSet, Record<string, unknown>> {
  return async ({ toolCall }) => {
    const toolDefinition = tools[toolCall.toolName];
    if (toolDefinition === undefined) return undefined;

    const approval = toolApprovals.get(toolDefinition);
    return (await approval?.(toolCall.input, toolCall.toolCallId)) as ToolApprovalStatus;
  };
}
