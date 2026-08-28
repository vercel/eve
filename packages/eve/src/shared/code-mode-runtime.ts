import type { ToolSet } from "ai";
import type * as CodeModeModule from "#compiled/@ai-sdk/code-mode/index.js";

const MODULE_KEY = Symbol.for("eve.codeModeRuntime.module");
const MODULE_SPECIFIER = ["#compiled", "@ai-sdk", "code-mode", "index.js"].join("/");

type RuntimeModule = Pick<
  typeof CodeModeModule,
  "CodeModeToolError" | "experimental_createCodeModeTool" | "experimental_runCodeMode"
>;
type RuntimeGlobal = typeof globalThis & { [MODULE_KEY]?: RuntimeModule };

let modulePromise: Promise<RuntimeModule> | undefined;

export const CODE_MODE_RUNTIME_LIMITS = {
  maxBridgeRequests: 64,
  maxInFlightBridgeRequests: 8,
  timeoutMs: 300_000,
} as const;

export const CODE_MODE_RUNTIME_OPTIONS = {
  executionPolicy: CODE_MODE_RUNTIME_LIMITS,
} as const;

export function installCodeModeRuntimeModule(module: RuntimeModule): void {
  (globalThis as RuntimeGlobal)[MODULE_KEY] = module;
}

export async function createCodeModeRuntimeTool(input: {
  readonly hostTools: ToolSet;
  readonly sourcePrefix?: string;
}): Promise<ToolSet[string]> {
  const { experimental_createCodeModeTool, experimental_runCodeMode } = await loadModule();
  const runtimeTool = experimental_createCodeModeTool(
    input.hostTools,
    CODE_MODE_RUNTIME_OPTIONS,
  ) as ToolSet[string];
  if (runtimeTool.execute === undefined) return runtimeTool;

  return {
    ...runtimeTool,
    execute: async (toolInput: { readonly js: string }, options: never) => {
      const deadline = Date.now() + CODE_MODE_RUNTIME_LIMITS.timeoutMs;
      const pending = new Set<Promise<void>>();
      try {
        return await experimental_runCodeMode({
          js:
            input.sourcePrefix === undefined
              ? toolInput.js
              : `${input.sourcePrefix}\n${toolInput.js}`,
          options: CODE_MODE_RUNTIME_OPTIONS,
          toolExecutionOptions: options,
          tools: trackHostTools(input.hostTools, pending),
        });
      } finally {
        await settleStartedHostExecutions(pending, deadline);
      }
    },
  } as ToolSet[string];
}

function trackHostTools(tools: ToolSet, pending: Set<Promise<void>>): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = tool.execute;
      if (execute === undefined) return [name, tool];
      return [
        name,
        {
          ...tool,
          execute: (input: never, options: never) => {
            const execution = Promise.resolve().then(() => execute(input, options));
            const settled = execution.then(
              () => undefined,
              () => undefined,
            );
            pending.add(settled);
            void settled.finally(() => pending.delete(settled));
            return execution;
          },
        },
      ];
    }),
  ) as ToolSet;
}

async function settleStartedHostExecutions(
  pending: Set<Promise<void>>,
  deadline: number,
): Promise<void> {
  while (pending.size > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(pending),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, remainingMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

/** Uses the installed runtime's renderer rather than maintaining an eve copy. */
export async function renderCodeModeToolSignature(
  name: string,
  hostTool: ToolSet[string],
): Promise<string> {
  const { experimental_createCodeModeTool } = await loadModule();
  const description = experimental_createCodeModeTool({ [name]: hostTool }).description;
  if (typeof description !== "string") {
    throw new Error(`The code-mode runtime could not render a signature for tool "${name}".`);
  }
  const marker = "declare const tools: {\n";
  const start = description.indexOf(marker);
  const end = description.indexOf("\n};", start + marker.length);
  if (start < 0 || end < 0) {
    throw new Error(`The code-mode runtime could not render a signature for tool "${name}".`);
  }
  return description.slice(start + marker.length, end);
}

export async function codeModeToolError(message: string): Promise<Error> {
  const { CodeModeToolError } = await loadModule();
  return new CodeModeToolError(message);
}

async function loadModule(): Promise<RuntimeModule> {
  const installed = (globalThis as RuntimeGlobal)[MODULE_KEY];
  if (installed !== undefined) return installed;
  modulePromise ??= import(MODULE_SPECIFIER) as Promise<RuntimeModule>;
  return await modulePromise;
}
