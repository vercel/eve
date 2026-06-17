import { type ToolSet } from "ai";

import type { SessionCapabilities } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import { isAuthorizationSignal } from "#harness/authorization.js";
import { CODE_MODE_RUNTIME_ACTION_INTERRUPT_KIND } from "#harness/code-mode-runtime-action-state.js";
import {
  CODE_MODE_CONNECTION_AUTH_INTERRUPT_KIND,
  markCodeModeToolExecutionOptions,
  toCodeModeConnectionAuthArgs,
} from "#runtime/framework-tools/code-mode-connection-auth.js";
import { loadCodeModeModule, type CodeModeOptions } from "#shared/code-mode.js";
import { ALL_SANDBOX_SURFACES, type SandboxSurface } from "#harness/sandbox-surface.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import { buildToolSet, buildToolSetFromDefinitions } from "#harness/tools.js";

/**
 * Framework tools that must never enter a sandbox — they stay directly callable
 * by the model even when code mode or Workflow is on. `load_skill` is a
 * control-plane action (it injects skill instructions into the session), not
 * data work to script, so code never calls it.
 */
const NEVER_SANDBOXED_TOOL_NAMES: ReadonlySet<string> = new Set([LOAD_SKILL_TOOL_NAME]);

interface SandboxPartitionInput {
  readonly lifecycle?: CodeModeOptions["lifecycle"];
  readonly tools: ToolSet;
  readonly harnessTools: HarnessToolMap;
  /** Sandbox surfaces to emit, in claim-priority order (first claim wins). */
  readonly surfaces: readonly SandboxSurface[];
}

interface SandboxPartition {
  readonly hostTools: ToolSet;
  readonly modelTools: ToolSet;
}

export function createEveCodeModeOptions(
  input: {
    readonly lifecycle?: CodeModeOptions["lifecycle"];
  } = {},
): CodeModeOptions {
  const options: {
    approval: {
      mode: "interrupt";
    };
    lifecycle?: CodeModeOptions["lifecycle"];
  } = {
    approval: {
      mode: "interrupt",
    },
  };

  if (input.lifecycle !== undefined) {
    options.lifecycle = input.lifecycle;
  }

  return options;
}

export async function applySandboxToolSet(input: SandboxPartitionInput): Promise<SandboxPartition> {
  const modelTools: Record<string, ToolSet[string]> = {};
  const buckets = new Map<SandboxSurface, Record<string, ToolSet[string]>>(
    input.surfaces.map((surface) => [surface, {}]),
  );

  for (const [name, tool] of Object.entries(input.tools)) {
    // Never-sandboxed tools (e.g. load_skill) stay directly callable and enter
    // no sandbox.
    if (NEVER_SANDBOXED_TOOL_NAMES.has(name)) {
      modelTools[name] = tool;
      continue;
    }

    const harnessTool = input.harnessTools.get(name);
    const isRuntimeAction = harnessTool?.runtimeAction !== undefined;

    // Agents stay directly callable by the model in addition to entering any
    // sandbox, so a single delegation never has to go through code.
    if (isRuntimeAction) {
      modelTools[name] = tool;
    }

    // A tool enters every sandbox that claims it. Agents are claimed by both
    // surfaces, so when code mode and Workflow are both enabled they are
    // callable from either sandbox; ordinary host tools are claimed only by
    // code mode.
    const claimingSurfaces = input.surfaces.filter((surface) => surface.claims(harnessTool, tool));
    if (claimingSurfaces.length === 0) {
      // Unclaimed and not an agent: a plain direct tool — provider-managed
      // tools, or any host tool when no code-mode surface is active.
      if (!isRuntimeAction) {
        modelTools[name] = tool;
      }
      continue;
    }

    const wrapped =
      isRuntimeAction && harnessTool !== undefined
        ? createRuntimeActionHostTool(harnessTool)
        : wrapHostToolForCodeMode(tool);
    for (const surface of claimingSurfaces) {
      buckets.get(surface)![name] = wrapped;
    }
  }

  const hostTools: Record<string, ToolSet[string]> = {};
  for (const surface of input.surfaces) {
    const bucket = buckets.get(surface)!;
    if (Object.keys(bucket).length === 0) {
      continue;
    }
    Object.assign(hostTools, bucket);
    modelTools[surface.toolName] = await createSandboxTool(surface, bucket, input.lifecycle);
  }

  return {
    hostTools: hostTools as ToolSet,
    modelTools: modelTools as ToolSet,
  };
}

/**
 * Builds one model-facing sandbox tool for a surface from its claimed host
 * tools. `createCodeModeTool` auto-generates a description listing the callable
 * tool signatures; the surface's optional {@link SandboxSurface.describe}
 * transform frames it (e.g. the agents-only Workflow framing).
 */
async function createSandboxTool(
  surface: SandboxSurface,
  hostTools: Record<string, ToolSet[string]>,
  lifecycle: CodeModeOptions["lifecycle"],
): Promise<ToolSet[string]> {
  const { createCodeModeTool } = await loadCodeModeModule();
  const base = createCodeModeTool(
    hostTools,
    createEveCodeModeOptions({ lifecycle }),
  ) as ToolSet[string];
  if (surface.describe === undefined) {
    return base;
  }
  const generated = typeof base.description === "string" ? base.description : "";
  return {
    ...base,
    description: surface.describe({ generated, toolNames: Object.keys(hostTools) }),
  } as ToolSet[string];
}

export async function buildSandboxHostTools(input: {
  readonly approvedTools?: ReadonlySet<string>;
  readonly capabilities?: SessionCapabilities;
  readonly tools: HarnessToolMap;
}): Promise<ToolSet> {
  const flatTools = buildToolSet({
    approvedTools: input.approvedTools,
    capabilities: input.capabilities,
    tools: input.tools,
  });

  const ctx = contextStorage.getStore();
  if (ctx !== undefined) {
    const dynamicTools = buildDynamicTools(ctx);
    const dynamicToolSet = buildToolSetFromDefinitions({
      approvedTools: input.approvedTools,
      capabilities: input.capabilities,
      tools: dynamicTools,
    });
    for (const [name, toolDefinition] of Object.entries(dynamicToolSet)) {
      flatTools[name] ??= toolDefinition;
    }
  }

  // Replay reconstructs the sandbox tool surface for whichever interrupt is
  // pending. Build across every known surface — a script only references its
  // own tools, so the superset is safe and lets any sandbox kind replay.
  return (
    await applySandboxToolSet({
      harnessTools: input.tools,
      tools: flatTools,
      surfaces: ALL_SANDBOX_SURFACES,
    })
  ).hostTools;
}

function createRuntimeActionHostTool(harnessTool: HarnessToolDefinition): ToolSet[string] {
  return {
    description: harnessTool.description,
    inputSchema: harnessTool.inputSchema,
    execute: async (input: never, options: never) => {
      const interrupt = (options as Record<string, unknown>)?.codeModeInterrupt as
        | { resolution?: unknown }
        | undefined;
      if (interrupt?.resolution !== undefined) {
        return interrupt.resolution;
      }
      const { requestCodeModeInterrupt } = await loadCodeModeModule();
      return requestCodeModeInterrupt({
        kind: CODE_MODE_RUNTIME_ACTION_INTERRUPT_KIND,
        runtimeAction: harnessTool.runtimeAction,
        toolInput: input,
        toolName: harnessTool.name,
      });
    },
  } as ToolSet[string];
}

function wrapHostToolForCodeMode(tool: ToolSet[string]): ToolSet[string] {
  const execute = tool.execute;

  if (execute === undefined) {
    return tool;
  }

  // No context plumbing here on purpose. Code mode bridges host-tool calls back
  // from a pooled `worker_thread`'s `message` callback; the package re-enters
  // the originating invocation's `AsyncLocalStorage` context before dispatching
  // `execute`/`needsApproval`/lifecycle hooks (experimental-ai-sdk-code-mode
  // >= 1.0.11) on every entry path, initial and continuation. So `ctx.session`,
  // auth, `getSandbox()`, and `defineState` already resolve against the running
  // session. This wrapper stays context-transparent and only translates the
  // host-tool authorization signal into a code-mode connection-auth interrupt.
  const invoke = async (input: never, options: never): Promise<unknown> => {
    const output = await resolveExecuteOutput(
      execute(input, markCodeModeToolExecutionOptions(options) as never),
    );
    if (isAuthorizationSignal(output)) {
      const { requestCodeModeInterrupt } = await loadCodeModeModule();
      const connectionName = output.challenges[0]?.name;
      if (connectionName) {
        requestCodeModeInterrupt({
          args: toCodeModeConnectionAuthArgs(input),
          challenges: output.challenges,
          connectionName,
          kind: CODE_MODE_CONNECTION_AUTH_INTERRUPT_KIND,
          toolName: "",
        });
      }
    }
    return output;
  };

  return {
    ...tool,
    execute: (input: never, options: never) => invoke(input, options),
  } as ToolSet[string];
}

async function resolveExecuteOutput(output: unknown): Promise<unknown> {
  if (isAsyncIterable(output)) {
    let finalOutput: unknown;
    for await (const part of output) {
      finalOutput = part;
    }
    return finalOutput;
  }
  return await output;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      "function"
  );
}
