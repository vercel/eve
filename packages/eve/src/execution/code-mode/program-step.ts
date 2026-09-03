import { asSchema, type ToolSet } from "ai";

import { deserializeContext } from "#context/serialize.js";
import { withContextScope } from "#context/run-step.js";
import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import { buildDynamicSubagentTools } from "#context/dynamic-subagent-lifecycle.js";
import { createNodeHarnessTools } from "#execution/node-step.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import type { CodeModeWorkflowInput } from "#execution/code-mode/schema.js";
import {
  CODE_MODE_BRIDGE_REQUEST_LIMIT,
  claimsForCodeMode,
  createDiscoveryTools,
  describeClaimedTool,
  isCodeModeAgentTool,
} from "#harness/code-mode.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { wrapToolExecute } from "#harness/tools.js";
import { getWorkflowContinuationSecurity } from "#harness/workflow-continuation-security.js";
import { getResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import {
  continueWorkflowSandboxInterrupt,
  createWorkflowSandboxTool,
  getWorkflowSandboxPendingInterrupts,
  requestWorkflowSandboxInterrupt,
  unwrapWorkflowSandboxResult,
  type WorkflowSandboxInterrupt,
} from "#shared/workflow-sandbox.js";
import type { ToolExecuteOptions } from "#tools/definition.js";

/** Interrupt payload raised by every claimed tool the generated program calls. */
export const CODE_MODE_CALL_INTERRUPT_KIND = "eve.code-mode-call";

export interface CodeModeCallInterrupt {
  readonly kind: typeof CODE_MODE_CALL_INTERRUPT_KIND;
  readonly target: "agent" | "tool";
  readonly toolInput: unknown;
  readonly toolName: string;
}

export type CodeModeProgramOutcome =
  | { readonly status: "completed"; readonly output: JsonValue }
  | {
      readonly status: "interrupted";
      readonly call: CodeModeCallInterrupt;
      readonly interrupt: WorkflowSandboxInterrupt;
      readonly toolCallId: string;
    };

interface CodeModeProgramInput {
  readonly callId: string;
  readonly program: CodeModeWorkflowInput;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Starts the generated program, or resumes it after one nested call settled.
 *
 * Every claimed tool is a stub that raises an interrupt, so this step never
 * performs a side effect itself: the sandbox parks at the first unresolved
 * call and returns a signed continuation. Replaying this step after a crash
 * therefore re-parks at the same call rather than re-firing anything.
 */
export async function runCodeModeProgramStep(
  input: CodeModeProgramInput & {
    readonly resume?: {
      readonly interrupt: WorkflowSandboxInterrupt;
      readonly resolution: unknown;
    };
  },
): Promise<CodeModeProgramOutcome> {
  "use step";

  const { hostTools, security } = await buildProgramHost(input);
  let raw: unknown;
  if (input.resume === undefined) {
    const tool = await createWorkflowSandboxTool({
      bridgeRequestLimit: CODE_MODE_BRIDGE_REQUEST_LIMIT,
      continuationSecurity: security,
      hostTools,
    });
    if (tool.execute === undefined) throw new Error("code_mode has no executor.");
    raw = await tool.execute(
      { js: input.program.js } as never,
      {
        toolCallId: input.callId,
      } as never,
    );
  } else {
    raw = await continueWorkflowSandboxInterrupt({
      bridgeRequestLimit: CODE_MODE_BRIDGE_REQUEST_LIMIT,
      continuationSecurity: security,
      interrupt: input.resume.interrupt,
      resolution: input.resume.resolution,
      tools: hostTools,
    });
  }
  const unwrapped = await unwrapWorkflowSandboxResult(raw, security);
  if (unwrapped.status === "completed") {
    return { output: parseJsonValue(unwrapped.output ?? null), status: "completed" };
  }
  // Promise.all may park several calls at once; settle them one at a time in
  // ledger order so each nested call keeps its own replay boundary.
  const pending = getWorkflowSandboxPendingInterrupts(unwrapped.interrupt)[0];
  if (pending === undefined) {
    throw new Error("code_mode continuation contains no pending call.");
  }
  return {
    call: readCallInterrupt(pending),
    interrupt: pending,
    status: "interrupted",
    toolCallId: pending.toolCallId,
  };
}

/**
 * Executes one ordinary claimed tool with the turn's context rebuilt from its
 * serialized form. The sandbox and connections resolve through the same
 * providers a turn step uses, so `bash`, `read_file`, connection tools, and
 * authored tools all run unchanged; the parent materialized the sandbox before
 * dispatching, so this step only reconnects to it.
 */
export async function executeCodeModeToolStep(input: {
  readonly callId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly toolCallId: string;
  readonly toolInput: unknown;
  readonly toolName: string;
}): Promise<{ readonly isError: boolean; readonly output: JsonValue }> {
  "use step";

  const { ctx, harnessTools, session } = await hydrateTurnTools(input);
  const definition = harnessTools.get(input.toolName);
  if (
    definition === undefined ||
    isCodeModeAgentTool(definition) ||
    !claimsForCodeMode(input.toolName, harnessTools)
  ) {
    return {
      isError: true,
      output: `Tool "${input.toolName}" is not available to code_mode in this session.`,
    };
  }
  const execute = wrapToolExecute(definition);
  if (execute === undefined) {
    return { isError: true, output: `Tool "${input.toolName}" has no executor.` };
  }
  const options: ToolExecuteOptions = {
    messages: [],
    toolCallId: input.toolCallId,
  } as ToolExecuteOptions;
  try {
    const scoped = await withContextScope(ctx, session, async (enriched) => {
      const result = await execute(input.toolInput, options);
      const output = isAsyncIterable(result) ? await lastOf(result) : result;
      return { result: output, session: enriched };
    });
    return { isError: false, output: parseJsonValue(scoped.result ?? null) };
  } catch (error) {
    return { isError: true, output: error instanceof Error ? error.message : String(error) };
  }
}

async function buildProgramHost(input: CodeModeProgramInput): Promise<{
  readonly hostTools: ToolSet;
  readonly security: ReturnType<typeof getWorkflowContinuationSecurity>;
}> {
  const { harnessTools, session } = await hydrateTurnTools(input);
  const hostTools: Record<string, ToolSet[string]> = {};
  for (const name of input.program.toolNames) {
    const definition = harnessTools.get(name);
    if (definition === undefined || !claimsForCodeMode(name, harnessTools)) continue;
    const target = isCodeModeAgentTool(definition) ? "agent" : "tool";
    hostTools[name] = {
      ...describeClaimedTool(definition),
      execute: async (toolInput: unknown) =>
        requestWorkflowSandboxInterrupt({
          kind: CODE_MODE_CALL_INTERRUPT_KIND,
          target,
          toolInput,
          toolName: name,
        } satisfies CodeModeCallInterrupt),
    } as ToolSet[string];
  }
  if (input.program.mode === "lazy") {
    const catalog = Object.fromEntries(
      Object.entries(hostTools).map(([name, tool]) => [
        name,
        { ...tool, inputSchema: asSchema(tool.inputSchema) },
      ]),
    );
    Object.assign(hostTools, createDiscoveryTools(catalog));
  }
  return { hostTools: hostTools as ToolSet, security: getWorkflowContinuationSecurity(session) };
}

async function hydrateTurnTools(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}) {
  const durable = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const effective = resolveEffectiveAgentRuntime(bundle, ctx);
  const baseNode = getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId);
  const node = { ...baseNode, turnAgent: effective.turnAgent };
  const session = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effective.thresholdPercent },
    durable,
    turnAgent: effective.turnAgent,
  });
  const harnessTools = new Map<string, HarnessToolDefinition>(createNodeHarnessTools({ node }));
  for (const dynamicSubagent of buildDynamicSubagentTools(ctx)) {
    harnessTools.set(dynamicSubagent.name, dynamicSubagent);
  }
  for (const dynamic of buildDynamicTools(ctx)) {
    harnessTools.set(dynamic.name, dynamic);
  }
  return { ctx, harnessTools, session };
}

function readCallInterrupt(interrupt: WorkflowSandboxInterrupt): CodeModeCallInterrupt {
  const payload = interrupt.payload as Partial<CodeModeCallInterrupt>;
  if (
    payload.kind !== CODE_MODE_CALL_INTERRUPT_KIND ||
    (payload.target !== "agent" && payload.target !== "tool") ||
    typeof payload.toolName !== "string"
  ) {
    throw new Error(`Unsupported code_mode interrupt kind "${String(payload.kind)}".`);
  }
  return {
    kind: CODE_MODE_CALL_INTERRUPT_KIND,
    target: payload.target,
    toolInput: payload.toolInput,
    toolName: payload.toolName,
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

async function lastOf(iterable: AsyncIterable<unknown>): Promise<unknown> {
  let last: unknown;
  for await (const value of iterable) last = value;
  return last;
}
