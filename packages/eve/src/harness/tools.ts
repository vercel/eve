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

/**
 * Describes harness tools to the AI SDK, each as `describe` words it. The SDK only calls the
 * model, so it gets no `execute`: eve runs every call itself (`#harness/call-executor.js`).
 *
 * Entries listed in `disabledProviderTools` are skipped entirely. Used
 * by the harness recovery path when a gateway fallback provider has
 * rejected a provider-specific tool — the tool is dropped for the
 * retry call so the request can proceed without it.
 */
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

/** A tool eve runs inside the step, rather than the runtime or the provider. */
export type RunnableTool = HarnessToolDefinition & {
  readonly execute: NonNullable<HarnessToolDefinition["execute"]>;
};

export function isRunnableTool(
  definition: HarnessToolDefinition | undefined,
): definition is RunnableTool {
  return definition?.execute !== undefined;
}

/**
 * Runs a tool's `execute` for one call, through its stub when an eval stubs it, as the caller who
 * approved the call. Outputs are normalized to JSON, except an {@link AuthorizationSignal}, which
 * the executor turns into a sign-in.
 */
export function invokeTool(
  definition: RunnableTool,
  input: unknown,
  options: ToolExecuteOptions,
): Promise<unknown> | AsyncIterable<unknown> {
  const { execute } = definition;
  let output: unknown;
  try {
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

/** Decides whether a call runs, needs a person's approval, or is denied. */
export async function decideApproval(
  definition: HarnessToolDefinition,
  call: ApprovalCall,
): Promise<ApprovalDecision> {
  if (definition.approval === undefined) return { denied: false };
  return await evaluateApproval(
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
}
