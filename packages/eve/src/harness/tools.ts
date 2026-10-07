import { type ToolApprovalConfiguration, type ToolApprovalStatus, type ToolSet, tool } from "ai";

import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { isObject } from "#shared/guards.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveApprovalPolicy } from "#approval/definition.js";
import { resolveWebSearchBackend, resolveWebSearchProviderTool } from "#harness/provider-tools.js";
import { entryModelOutput, stubbedCall } from "#harness/execute-call.js";
import type { CallResolver, HarnessToolMap } from "#harness/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { loadContext } from "#context/container.js";
import { isAuthorizationSignal, modelFacingAuthorizationOutput } from "#harness/authorization.js";
import { stashToolInterrupt } from "#harness/tool-interrupts.js";
import { isApprovedToolCall, markApprovalRecheck } from "#harness/approval-recheck.js";
import { toModelSchema } from "#tools/schema.js";
import { normalizeToolJsonOutput } from "#harness/tool-model-output.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { executeWithToolStub } from "#tool-stubs/execute.js";
import { iterateAsApprover, runAsApprover } from "#harness/hitl/approved-call-callers.js";

/**
 * Builds an AI SDK `ToolSet` from unified harness tool definitions, described
 * by `describe`. Each call's output is projected by the entry `resolve`
 * resolves it to.
 *
 * Tools without `execute` are surfaced to the model as client-side tools
 * (no server execution).
 *
 * Entries listed in `disabledProviderTools` are skipped entirely. Used
 * by the harness recovery path when a gateway fallback provider has
 * rejected a provider-specific tool — the tool is dropped for the
 * retry call so the request can proceed without it.
 */
export function buildToolSet(input: {
  readonly describe: (definition: HarnessToolDefinition) => string;
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly resolve: CallResolver;
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
      execute: wrapToolExecute(definition, input.resolve),
      inputSchema: toModelSchema(definition.inputSchema, "input"),
      strict: false,
      outputSchema: toModelSchema(definition.outputSchema, "output"),
      ...(definition.execute !== undefined || definition.toModelOutput !== undefined
        ? {
            toModelOutput: ({
              input: callInput,
              output,
              toolCallId,
            }: {
              readonly input: unknown;
              readonly output: unknown;
              readonly toolCallId?: string;
            }) =>
              entryModelOutput(
                input.resolve({ input: callInput, toolName: definition.name })?.definition ??
                  definition,
                output,
                toolCallId,
              ),
          }
        : {}),
    });
  }

  return tools as ToolSet;
}

/**
 * Wraps a tool's `execute` so a returned {@link AuthorizationSignal} is
 * stashed out-of-band ({@link stashToolInterrupt}) for the park detector while
 * the AI SDK records an opaque {@link AuthorizationPendingModelOutput} that
 * omits OAuth URLs, user codes, and hook URLs from model-facing history.
 * Returns `undefined` for client-side tools (no `execute`). With `resolve`,
 * output is normalized under the name of the entry each call resolves to, so
 * an error from a call through `execute` names the entry, and a tool stub
 * matches that entry and its input, as it would a direct call.
 */
export function wrapToolExecute(
  definition: HarnessToolDefinition,
  resolve?: CallResolver,
): ((input: any, options: ToolExecuteOptions) => Promise<any> | AsyncIterable<any>) | undefined {
  const execute = definition.execute;
  if (execute === undefined) return undefined;

  return (input, options) => {
    const self = { input, toolName: definition.name };
    const resolved = resolve?.(self);
    const toolName = resolved?.definition.name ?? definition.name;
    const call = stubbedCall(self, resolved);
    const run = () => execute(input, options);
    let output: unknown;
    try {
      output = runAsApprover(options.toolCallId, () =>
        call === undefined ? run() : executeWithToolStub(call.toolName, call.input, options, run),
      );
    } catch (error) {
      return Promise.reject(error);
    }

    if (isAsyncIterable(output)) {
      return normalizeToolExecuteIterable(
        iterateAsApprover(options.toolCallId, output),
        toolName,
        options,
      );
    }

    return Promise.resolve(output).then((value) =>
      normalizeToolExecuteOutput(value, toolName, options),
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
 * Tool names listed in `disabledProviderTools` are skipped entirely —
 * both the framework definition and the injected provider tool are
 * omitted from the returned set. Used by the harness recovery path when
 * a gateway fallback provider has rejected a provider-specific tool.
 */
export async function buildToolSetWithProviderTools(input: {
  readonly describe: (definition: HarnessToolDefinition) => string;
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly modelReference: RuntimeModelReference;
  readonly modelProvider?: string;
  readonly resolve: CallResolver;
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
      const backend = resolveWebSearchBackend(
        input.modelReference,
        handling.provider,
        input.modelProvider,
      );
      if (backend === null) {
        delete tools[definition.name];
      } else {
        tools[definition.name] = await resolveWebSearchProviderTool(backend);
      }
    }
  }

  return tools;
}

/**
 * Builds the AI SDK 7 call-level approval policy: each call is approved by the
 * entry it runs, under that entry's name and with its own input.
 */
export function buildToolApproval(input: {
  readonly abortSignal?: AbortSignal;
  readonly approvedTools: ReadonlySet<string>;
  readonly resolve: CallResolver;
}): ToolApprovalConfiguration<ToolSet, Record<string, unknown>> {
  return async ({ toolCall, messages }) => {
    const resolved = input.resolve(toolCall);
    if (resolved === undefined) return undefined;
    return await evaluateApproval(resolved.definition, {
      abortSignal: input.abortSignal,
      approvedTools: input.approvedTools,
      callId: toolCall.toolCallId,
      input: resolved.call.input,
      recheck: isApprovedToolCall(messages, toolCall.toolCallId),
    });
  };
}

/**
 * Re-runs a tool's approval policy for a call a person approved, just before eve runs it, so the
 * policy can still refuse it, as when the connection it was approved against changed.
 */
export async function recheckApprovedCall(
  definition: HarnessToolDefinition,
  call: {
    readonly callId: string;
    readonly input: unknown;
    readonly abortSignal?: AbortSignal;
    readonly approvedTools?: ReadonlySet<string>;
  },
): Promise<{ readonly denied: boolean; readonly reason?: string }> {
  const status = await evaluateApproval(definition, { ...call, recheck: true });
  if (status === "denied") return { denied: true };
  if (typeof status === "object" && status !== null && status.type === "denied") {
    return { denied: true, reason: status.reason };
  }
  return { denied: false };
}

/** Runs `definition`'s approval policy for one call, in the status form the AI SDK reads. */
async function evaluateApproval(
  definition: HarnessToolDefinition,
  call: {
    readonly abortSignal?: AbortSignal;
    readonly approvedTools?: ReadonlySet<string>;
    readonly callId: string;
    readonly input: unknown;
    readonly recheck: boolean;
  },
): Promise<ToolApprovalStatus | undefined> {
  if (definition.approval === undefined) return undefined;
  const context = {
    ...buildCallbackContext(),
    abortSignal: call.abortSignal ?? new AbortController().signal,
    approvedTools: call.approvedTools ?? new Set<string>(),
    callId: call.callId,
    toolInput: isObject(call.input) ? call.input : undefined,
    toolName: definition.name,
  };
  const status = await resolveApprovalPolicy(definition.approval)(
    call.recheck ? markApprovalRecheck(context) : context,
  );
  return (
    typeof status === "boolean" ? (status ? "user-approval" : "not-applicable") : status
  ) as ToolApprovalStatus;
}
