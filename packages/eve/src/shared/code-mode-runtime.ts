import type { ToolSet } from "ai";
import type * as CodeModeModule from "#compiled/experimental-ai-sdk-code-mode/index.js";

const MODULE_KEY = Symbol.for("eve.codeModeRuntime.module");
const MODULE_SPECIFIER = ["#compiled", "experimental-ai-sdk-code-mode", "index.js"].join("/");

type RuntimeModule = Pick<typeof CodeModeModule, "CodeModeToolError" | "createCodeModeTool">;
type RuntimeGlobal = typeof globalThis & { [MODULE_KEY]?: RuntimeModule };

let modulePromise: Promise<RuntimeModule> | undefined;

export const CODE_MODE_RUNTIME_LIMITS = {
  maxBridgeRequests: 64,
  maxInFlightBridgeRequests: 8,
  timeoutMs: 300_000,
} as const;

export const CODE_MODE_RUNTIME_OPTIONS = {
  executionPolicy: CODE_MODE_RUNTIME_LIMITS,
  fetchPolicy: false,
} as const;

export function installCodeModeRuntimeModule(module: RuntimeModule): void {
  (globalThis as RuntimeGlobal)[MODULE_KEY] = module;
}

export async function createCodeModeRuntimeTool(input: {
  readonly hostTools: ToolSet;
  readonly sourcePrefix?: string;
}): Promise<ToolSet[string]> {
  const { createCodeModeTool } = await loadModule();
  const runtimeTool = createCodeModeTool(
    input.hostTools,
    CODE_MODE_RUNTIME_OPTIONS,
  ) as ToolSet[string];
  const execute = runtimeTool.execute;
  if (input.sourcePrefix === undefined || execute === undefined) return runtimeTool;

  return {
    ...runtimeTool,
    execute: (toolInput: { readonly js: string }, options: never) =>
      execute({ ...toolInput, js: `${input.sourcePrefix}\n${toolInput.js}` } as never, options),
  } as ToolSet[string];
}

/** Uses the installed runtime's renderer rather than maintaining an eve copy. */
export async function renderCodeModeToolSignature(
  name: string,
  hostTool: ToolSet[string],
): Promise<string> {
  const { createCodeModeTool } = await loadModule();
  const description = createCodeModeTool({ [name]: hostTool }, { fetchPolicy: false }).description;
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
