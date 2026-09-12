import type { FlexibleSchema, ToolSet } from "ai";
import type * as CodeModeModule from "#compiled/@ai-sdk/code-mode/index.js";

const WORKFLOW_SANDBOX_MODULE_KEY = Symbol.for("eve.workflowSandbox.module");
const WORKFLOW_SANDBOX_MODULE_SPECIFIER = ["#compiled", "@ai-sdk", "code-mode", "index.js"].join(
  "/",
);

type WorkflowSandboxModule = {
  readonly CodeModeToolError: typeof CodeModeModule.CodeModeToolError;
  readonly continueCodeModeInterrupt: typeof CodeModeModule.experimental_continueCodeModeInterrupt;
  readonly createCodeModeTool: typeof CodeModeModule.experimental_createCodeModeTool;
  readonly getCodeModeInterrupt: typeof CodeModeModule.experimental_getCodeModeInterrupt;
  readonly requestCodeModeInterrupt: typeof CodeModeModule.experimental_requestCodeModeInterrupt;
  readonly unwrapCodeModeResult: typeof CodeModeModule.experimental_unwrapCodeModeResult;
};

type WorkflowSandboxGlobal = typeof globalThis & {
  [WORKFLOW_SANDBOX_MODULE_KEY]?: WorkflowSandboxModule;
};

export type WorkflowSandboxInterrupt = CodeModeModule.CodeModeInterrupt;
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
}): Promise<ToolSet[string]> {
  const { createCodeModeTool } = await loadWorkflowSandboxModule();
  return createCodeModeTool(
    input.hostTools,
    createWorkflowSandboxOptions(input.bridgeRequestLimit, input.continuationSecurity),
  ) as ToolSet[string];
}

export async function requestWorkflowSandboxInterrupt(input: {
  readonly kind: string;
  readonly task: unknown;
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
  readonly resolution: unknown;
  readonly tools: ToolSet;
}): Promise<unknown> {
  const { continueCodeModeInterrupt } = await loadWorkflowSandboxModule();
  return continueCodeModeInterrupt({
    interrupt: input.interrupt,
    options: createWorkflowSandboxOptions(input.bridgeRequestLimit, input.continuationSecurity),
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

export type WorkflowSandboxResolution =
  | { readonly status: "completed"; readonly output: unknown }
  | { readonly status: "failed"; readonly error: string };

/** A host tool that parks on first call and consumes its resolution on replay. */
export function createParkingHostTool(input: {
  readonly description: string;
  readonly inputSchema: FlexibleSchema;
  readonly outputSchema?: FlexibleSchema | null;
  readonly interrupt: (toolInput: unknown) => { readonly kind: string } & Record<string, unknown>;
}): ToolSet[string] {
  return {
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema ?? undefined,
    execute: async (toolInput: unknown, options: unknown) => {
      const module = await loadWorkflowSandboxModule();
      const resolution = readWorkflowSandboxResolution(options);
      if (resolution?.status === "failed") throw new module.CodeModeToolError(resolution.error);
      if (resolution?.status === "completed") return resolution.output;
      return module.requestCodeModeInterrupt(input.interrupt(toolInput));
    },
  } as ToolSet[string];
}

export function readWorkflowSandboxResolution(
  options: unknown,
): WorkflowSandboxResolution | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const interrupt = (options as Record<string, unknown>).codeModeInterrupt;
  if (typeof interrupt !== "object" || interrupt === null) return undefined;
  const resolution = (interrupt as Record<string, unknown>).resolution;
  if (typeof resolution !== "object" || resolution === null) return undefined;
  const status = (resolution as Record<string, unknown>).status;
  return status === "completed" || status === "failed"
    ? (resolution as WorkflowSandboxResolution)
    : undefined;
}

/** Reconstructs every unresolved interruption from the authenticated continuation. */
export function getWorkflowSandboxPendingInterrupts(
  interrupt: WorkflowSandboxInterrupt,
): WorkflowSandboxInterrupt[] {
  const continuation = interrupt.continuation;
  const resolved = new Set(
    continuation.resolutions.map((resolution) => resolution.runInterruptionId),
  );

  return continuation.pendingInterruptions.flatMap((pending) =>
    resolved.has(pending.runInterruptionId)
      ? []
      : [
          {
            continuation,
            input: pending.input,
            interruptId: pending.interruptId,
            outerToolCallId: continuation.outerToolCallId,
            payload: pending.payload,
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            type: "code-mode-interrupt" as const,
          },
        ],
  );
}

function createWorkflowSandboxOptions(
  bridgeRequestLimit: number,
  continuationSecurity: WorkflowSandboxContinuationSecurity,
): CodeModeModule.CodeModeOptions {
  return {
    continuationSecurity,
    executionPolicy: {
      maxBridgeRequests: bridgeRequestLimit,
      maxInFlightBridgeRequests: bridgeRequestLimit,
    },
  };
}

async function loadWorkflowSandboxModule(): Promise<WorkflowSandboxModule> {
  const installed = (globalThis as WorkflowSandboxGlobal)[WORKFLOW_SANDBOX_MODULE_KEY];
  if (installed !== undefined) return installed;

  workflowSandboxModulePromise ??= importWorkflowSandboxModule(WORKFLOW_SANDBOX_MODULE_SPECIFIER);
  return await workflowSandboxModulePromise;
}

async function importWorkflowSandboxModule(specifier: string): Promise<WorkflowSandboxModule> {
  const module = (await import(specifier)) as typeof CodeModeModule;
  return {
    CodeModeToolError: module.CodeModeToolError,
    continueCodeModeInterrupt: module.experimental_continueCodeModeInterrupt,
    createCodeModeTool: module.experimental_createCodeModeTool,
    getCodeModeInterrupt: module.experimental_getCodeModeInterrupt,
    requestCodeModeInterrupt: module.experimental_requestCodeModeInterrupt,
    unwrapCodeModeResult: module.experimental_unwrapCodeModeResult,
  };
}
