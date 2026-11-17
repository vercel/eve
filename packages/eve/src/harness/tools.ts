import { mintClearance, requireClearance, type Clearance } from "#harness/clearance.js";
import { type ToolSet, tool } from "ai";

import type { ModelProfile } from "#harness/model-profile.js";
import { isObject } from "#shared/guards.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveApprovalPolicy } from "#approval/definition.js";
import { resolveWebSearchBackend, resolveWebSearchProviderTool } from "#harness/provider-tools.js";
import type { HarnessToolMap } from "#harness/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { isAuthorizationSignal } from "#harness/authorization.js";
import { type ApprovalMemory, evaluateApproval } from "#approval/evaluation.js";
import type { ApprovalDecision } from "#approval/status.js";
import { toModelSchema } from "#tools/schema.js";
import { normalizeToolJsonOutput } from "#harness/tool-model-output.js";
import { createLogger } from "#internal/logging.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { executeWithToolStub } from "#tool-stubs/execute.js";

const log = createLogger("harness.tools");

export function buildToolSet(input: {
  readonly describe: (definition: HarnessToolDefinition) => string;
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly tools: HarnessToolMap;
}): ToolSet {
  const tools: Record<string, ToolSet[string]> = {};
  const disabled = input.disabledProviderTools;

  for (const definition of input.tools.values()) {
    if (disabled?.has(definition.name)) {
      continue;
    }
    tools[definition.name] = tool({
      description: input.describe(definition),
      inputSchema: toModelSchema(definition.inputSchema, "input"),
      strict: false,
      outputSchema: toModelSchema(definition.outputSchema, "output"),
    });
  }

  return tools as ToolSet;
}

export type RunnableTool = HarnessToolDefinition & {
  readonly execute: NonNullable<HarnessToolDefinition["execute"]>;
};

export function isRunnableTool(
  definition: HarnessToolDefinition | undefined,
): definition is RunnableTool {
  return definition?.execute !== undefined;
}

export function invokeTool(
  definition: RunnableTool,
  input: unknown,
  options: ToolExecuteOptions,
  clearance: Clearance,
): Promise<unknown> | AsyncIterable<unknown> {
  const { execute } = definition;
  let output: unknown;
  try {
    requireClearance(clearance, options.toolCallId);
    output = executeWithToolStub(definition.name, input, options, () => execute(input, options));
  } catch (error) {
    return Promise.reject(error);
  }

  if (isAsyncIterable(output)) {
    return normalizeToolExecuteIterable(output, definition.name, options);
  }

  return Promise.resolve(output).then((value) =>
    normalizeToolExecuteOutput(value, definition.name, options),
  );
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
  if (isAuthorizationSignal(output)) return output;
  return normalizeToolJsonOutput({
    boundary: "execute",
    output,
    toolCallId: options.toolCallId,
    toolName,
  });
}

export async function buildToolSetWithProviderTools(input: {
  readonly describe: (definition: HarnessToolDefinition) => string;
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly profile: ModelProfile;
  readonly tools: HarnessToolMap;
}): Promise<ToolSet> {
  const disabled = input.disabledProviderTools;
  const tools: ToolSet = { ...buildToolSet(input) };

  for (const definition of input.tools.values()) {
    const handling = definition.behavior?.handling;
    if (
      handling?.kind === "provider-tool" &&
      definition.execute === undefined &&
      !disabled?.has(definition.name)
    ) {
      const backend = resolveWebSearchBackend(input.profile, handling);
      if (backend === null) {
        log.debug("model has no web search backend; leaving the tool out", {
          gateway: input.profile.gateway,
          modelProvider: input.profile.provider,
          searchProvider: handling.provider,
          tool: definition.name,
        });
        delete tools[definition.name];
      } else {
        tools[definition.name] = await resolveWebSearchProviderTool(backend);
      }
    }
  }

  return tools;
}

interface ApprovalCall {
  readonly callId: string;
  readonly input: unknown;
  readonly abortSignal?: AbortSignal;
  readonly approvalMemory?: ApprovalMemory;
  readonly recheck?: boolean;
}

export interface GateDecision extends ApprovalDecision {
  readonly clearance?: Clearance;
}

export async function decideApproval(
  definition: HarnessToolDefinition,
  call: ApprovalCall,
): Promise<GateDecision> {
  const decision: ApprovalDecision =
    definition.approval === undefined
      ? { denied: false }
      : await evaluateApproval(
          resolveApprovalPolicy(definition.approval),
          {
            ...buildCallbackContext(),
            abortSignal: call.abortSignal ?? new AbortController().signal,
            callId: call.callId,
            toolInput: isObject(call.input) ? call.input : undefined,
            toolName: definition.name,
          },
          { memory: call.approvalMemory, recheck: call.recheck },
        );
  if (decision.denied || decision.awaitsPerson === true) return decision;
  return { ...decision, clearance: mintClearance(call.callId, decision.clearedBy) };
}
