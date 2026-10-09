import { type ToolSet, tool } from "ai";

import type { ModelProfile } from "#harness/model-profile.js";
import { isObject } from "#shared/guards.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveApprovalPolicy, type ApprovalStatus } from "#approval/definition.js";
import { resolveWebSearchBackend, resolveWebSearchProviderTool } from "#harness/provider-tools.js";
import type { HarnessToolMap } from "#harness/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { isAuthorizationSignal } from "#harness/authorization.js";
import { markApprovalRecheck } from "#harness/approval-recheck.js";
import { toModelSchema } from "#tools/schema.js";
import { normalizeToolJsonOutput } from "#harness/tool-model-output.js";
import { createLogger } from "#internal/logging.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { executeWithToolStub } from "#tool-stubs/execute.js";
import { iterateAsApprover, runAsApprover } from "#harness/hitl/approved-call-callers.js";

const log = createLogger("harness.tools");

type NativeApprovalStatus = Exclude<ApprovalStatus, boolean>;

type ApprovalFn = (
  toolInput: unknown,
  callId: string,
  abortSignal: AbortSignal | undefined,
  recheck: boolean,
) => Promise<NativeApprovalStatus>;

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
    output = runAsApprover(options.toolCallId, () =>
      executeWithToolStub(definition.name, input, options, () => execute(input, options)),
    );
  } catch (error) {
    return Promise.reject(error);
  }

  if (isAsyncIterable(output)) {
    return normalizeToolExecuteIterable(
      iterateAsApprover(options.toolCallId, output),
      definition.name,
      options,
    );
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

function buildApprovalFn(
  definition: HarnessToolDefinition,
  input: { readonly approvedTools?: ReadonlySet<string> },
): ApprovalFn {
  return async (toolInput, callId, abortSignal, recheck) => {
    if (definition.approval === undefined) return undefined;

    const toolInputRecord = isObject(toolInput) ? toolInput : undefined;
    const context = {
      ...buildCallbackContext(),
      abortSignal: abortSignal ?? new AbortController().signal,
      approvedTools: input.approvedTools ?? new Set<string>(),
      callId,
      toolInput: toolInputRecord,
      toolName: definition.name,
    };

    const status = await resolveApprovalPolicy(definition.approval)(
      recheck ? markApprovalRecheck(context) : context,
    );
    return typeof status === "boolean" ? (status ? "user-approval" : "not-applicable") : status;
  };
}

/** The tool's approval policy's decision for a call, in the AI SDK's status vocabulary. */
export async function approvalStatus(
  definition: HarnessToolDefinition,
  call: {
    readonly callId: string;
    readonly input: unknown;
    readonly abortSignal?: AbortSignal;
    readonly approvedTools?: ReadonlySet<string>;
    /** The call is one a person already approved, about to run. */
    readonly recheck?: boolean;
  },
): Promise<NativeApprovalStatus> {
  return await buildApprovalFn(definition, { approvedTools: call.approvedTools })(
    call.input,
    call.callId,
    call.abortSignal,
    call.recheck === true,
  );
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
  const status = await approvalStatus(definition, { ...call, recheck: true });
  if (status === "denied") return { denied: true };
  if (typeof status === "object" && status !== null && status.type === "denied") {
    return { denied: true, reason: status.reason };
  }
  return { denied: false };
}

/**
 * Decides a call the model just made: it runs, waits for a person, or is denied, as the tool's
 * approval policy says.
 */
export async function decideApproval(
  definition: HarnessToolDefinition,
  call: {
    readonly callId: string;
    readonly input: unknown;
    readonly abortSignal?: AbortSignal;
    readonly approvedTools?: ReadonlySet<string>;
  },
): Promise<{ readonly awaitsPerson?: true; readonly denied: boolean; readonly reason?: string }> {
  const status = await approvalStatus(definition, call);
  if (status === "user-approval") return { awaitsPerson: true, denied: false };
  if (typeof status === "object" && status !== null && status.type === "user-approval") {
    return { awaitsPerson: true, denied: false };
  }
  if (status === "denied") return { denied: true };
  if (typeof status === "object" && status !== null && status.type === "denied") {
    return { denied: true, reason: status.reason };
  }
  return { denied: false };
}
