import type { ToolSet } from "ai";
import type * as CodeModeModule from "#compiled/experimental-ai-sdk-code-mode/index.js";

/** Model-facing tool name for eve's dynamic subagent orchestration tool. */
export const WORKFLOW_TOOL_NAME = "Workflow";

const WORKFLOW_SANDBOX_MODULE_KEY = Symbol.for("eve.workflowSandbox.module");
const WORKFLOW_SANDBOX_MODULE_SPECIFIER = [
  "#compiled",
  "experimental-ai-sdk-code-mode",
  "index.js",
].join("/");

type WorkflowSandboxModule = Pick<
  typeof CodeModeModule,
  | "continueCodeModeInterrupt"
  | "createCodeModeTool"
  | "getCodeModeInterrupt"
  | "requestCodeModeInterrupt"
  | "unwrapCodeModeResult"
>;

type WorkflowSandboxGlobal = typeof globalThis & {
  [WORKFLOW_SANDBOX_MODULE_KEY]?: WorkflowSandboxModule;
};

export type WorkflowSandboxInterrupt = CodeModeModule.CodeModeInterrupt;
export type WorkflowSandboxLifecycle = NonNullable<CodeModeModule.CodeModeOptions["lifecycle"]>;
export type WorkflowSandboxContinuationSecurity =
  CodeModeModule.CodeModeContinuationSecurityOptions;

let workflowSandboxModulePromise: Promise<WorkflowSandboxModule> | undefined;

export function installWorkflowSandboxModule(module: WorkflowSandboxModule): void {
  (globalThis as WorkflowSandboxGlobal)[WORKFLOW_SANDBOX_MODULE_KEY] = module;
}

export async function createWorkflowSandboxTool(input: {
  readonly bridgeRequestLimit: number;
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly hostTools: ToolSet;
  readonly lifecycle?: WorkflowSandboxLifecycle;
}): Promise<ToolSet[string]> {
  const { createCodeModeTool } = await loadWorkflowSandboxModule();
  return createCodeModeTool(
    input.hostTools,
    createWorkflowSandboxOptions(
      input.bridgeRequestLimit,
      input.continuationSecurity,
      input.lifecycle,
    ),
  ) as ToolSet[string];
}

export async function requestWorkflowSandboxInterrupt(input: {
  readonly kind: string;
  readonly runtimeAction: unknown;
  readonly toolInput: unknown;
  readonly toolName: string;
}): Promise<unknown> {
  const { requestCodeModeInterrupt } = await loadWorkflowSandboxModule();
  return requestCodeModeInterrupt(input);
}

export async function getWorkflowSandboxInterrupt(
  result: unknown,
  continuationSecurity: WorkflowSandboxContinuationSecurity,
): Promise<WorkflowSandboxInterrupt | undefined> {
  const { getCodeModeInterrupt } = await loadWorkflowSandboxModule();
  return getCodeModeInterrupt(result as never, continuationSecurity);
}

export async function continueWorkflowSandboxInterrupt(input: {
  readonly bridgeRequestLimit: number;
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly lifecycle?: WorkflowSandboxLifecycle;
  readonly resolution: unknown;
  readonly tools: ToolSet;
}): Promise<unknown> {
  const { continueCodeModeInterrupt } = await loadWorkflowSandboxModule();
  return continueCodeModeInterrupt({
    interrupt: input.interrupt,
    options: createWorkflowSandboxOptions(
      input.bridgeRequestLimit,
      input.continuationSecurity,
      input.lifecycle,
    ),
    resolution: input.resolution,
    tools: input.tools,
  } as never);
}

export async function unwrapWorkflowSandboxResult(
  value: unknown,
  continuationSecurity: WorkflowSandboxContinuationSecurity,
): Promise<
  | { readonly output: unknown; readonly status: "completed" }
  | { readonly interrupt: WorkflowSandboxInterrupt; readonly status: "interrupted" }
> {
  const { unwrapCodeModeResult } = await loadWorkflowSandboxModule();
  return unwrapCodeModeResult(value, continuationSecurity) as
    | { readonly output: unknown; readonly status: "completed" }
    | { readonly interrupt: WorkflowSandboxInterrupt; readonly status: "interrupted" };
}

export function readWorkflowSandboxResolution(options: unknown): unknown {
  if (typeof options !== "object" || options === null) return undefined;
  const interrupt = (options as Record<string, unknown>).codeModeInterrupt;
  if (typeof interrupt !== "object" || interrupt === null) return undefined;
  return (interrupt as Record<string, unknown>).resolution;
}

function createWorkflowSandboxOptions(
  bridgeRequestLimit: number,
  continuationSecurity: WorkflowSandboxContinuationSecurity,
  lifecycle: WorkflowSandboxLifecycle | undefined,
): CodeModeModule.CodeModeOptions {
  const options: CodeModeModule.CodeModeOptions = {
    continuationSecurity,
    executionPolicy: {
      maxBridgeRequests: bridgeRequestLimit,
      maxInFlightBridgeRequests: bridgeRequestLimit,
    },
  };
  if (lifecycle !== undefined) options.lifecycle = lifecycle;
  return options;
}

async function loadWorkflowSandboxModule(): Promise<WorkflowSandboxModule> {
  const installed = (globalThis as WorkflowSandboxGlobal)[WORKFLOW_SANDBOX_MODULE_KEY];
  if (installed !== undefined) return installed;

  workflowSandboxModulePromise ??= importWorkflowSandboxModule(WORKFLOW_SANDBOX_MODULE_SPECIFIER);
  return await workflowSandboxModulePromise;
}

async function importWorkflowSandboxModule(specifier: string): Promise<WorkflowSandboxModule> {
  return (await import(specifier)) as WorkflowSandboxModule;
}
