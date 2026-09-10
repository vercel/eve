import { jsonSchema, type ToolSet } from "ai";
import type * as CodeModeModule from "#compiled/@ai-sdk/code-mode/index.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

const WORKFLOW_SANDBOX_MODULE_KEY = Symbol.for("eve.workflowSandbox.module");
const WORKFLOW_SANDBOX_MODULE_SPECIFIER = ["#compiled", "@ai-sdk", "code-mode", "index.js"].join(
  "/",
);

type WorkflowSandboxModule = {
  readonly CodeModeToolError: typeof CodeModeModule.CodeModeToolError;
  readonly continueCodeModeInterrupt: typeof CodeModeModule.experimental_continueCodeModeInterrupt;
  readonly createCodeModeTool: typeof CodeModeModule.experimental_createCodeModeTool;
  readonly requestCodeModeInterrupt: typeof CodeModeModule.experimental_requestCodeModeInterrupt;
  readonly unwrapCodeModeResult: typeof CodeModeModule.experimental_unwrapCodeModeResult;
};

type WorkflowSandboxGlobal = typeof globalThis & {
  [WORKFLOW_SANDBOX_MODULE_KEY]?: WorkflowSandboxModule;
};

export type WorkflowSandboxInterrupt = CodeModeModule.CodeModeInterrupt;
export type WorkflowSandboxContinuationSecurity =
  CodeModeModule.CodeModeContinuationSecurityOptions;

export type WorkflowSandboxResolution =
  | { readonly status: "completed"; readonly output: JsonValue }
  | { readonly status: "failed"; readonly error: string };

export type WorkflowSandboxOutcome =
  | { readonly status: "completed"; readonly output: unknown }
  | {
      readonly status: "interrupted";
      readonly interrupt: WorkflowSandboxInterrupt;
      readonly pending: readonly WorkflowSandboxInterrupt[];
    }
  | { readonly status: "failed"; readonly error: string };

export interface WorkflowSandbox {
  /** Model-facing description the SDK generates from the host tools. */
  readonly description: string;
  run(input: { readonly js: string; readonly toolCallId: string }): Promise<WorkflowSandboxOutcome>;
  /** Settles one parked batch in pending order and re-runs the program. */
  resume(input: {
    readonly interrupt: WorkflowSandboxInterrupt;
    readonly resolutions: readonly WorkflowSandboxResolution[];
  }): Promise<WorkflowSandboxOutcome>;
}

let workflowSandboxModulePromise: Promise<WorkflowSandboxModule> | undefined;

export function installWorkflowSandboxModule(module: WorkflowSandboxModule): void {
  (globalThis as WorkflowSandboxGlobal)[WORKFLOW_SANDBOX_MODULE_KEY] = module;
}

export async function createWorkflowSandbox(input: {
  readonly hostTools: ToolSet;
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly bridgeRequestLimit: number;
}): Promise<WorkflowSandbox> {
  const module = await loadWorkflowSandboxModule();
  const { continuationSecurity, hostTools } = input;
  const options = createWorkflowSandboxOptions(input.bridgeRequestLimit, continuationSecurity);
  const tool = module.createCodeModeTool(hostTools, options) as ToolSet[string];

  const classify = (raw: unknown): WorkflowSandboxOutcome => {
    const unwrapped = module.unwrapCodeModeResult(raw, continuationSecurity);
    if (unwrapped.status === "completed") {
      return { status: "completed", output: unwrapped.output };
    }
    return {
      status: "interrupted",
      interrupt: unwrapped.interrupt,
      pending: pendingInterruptsOf(unwrapped.interrupt),
    };
  };

  return {
    description: typeof tool.description === "string" ? tool.description : "",
    run: (run) =>
      settle(async () => {
        if (tool.execute === undefined) throw new Error("Workflow sandbox has no executor.");
        // `ToolSet[string]` erases the input type; the sandbox tool accepts `{ js }`.
        const raw = await tool.execute(
          { js: run.js } as never,
          { messages: [], toolCallId: run.toolCallId } as never,
        );
        return classify(raw);
      }),
    resume: (resume) =>
      settle(async () => {
        const pending = pendingInterruptsOf(resume.interrupt);
        if (pending.length === 0) {
          throw new Error("Workflow sandbox interrupt contains no pending call.");
        }
        if (resume.resolutions.length !== pending.length) {
          throw new Error(
            `Workflow sandbox resumed with ${String(resume.resolutions.length)} resolutions for ${String(pending.length)} pending calls.`,
          );
        }
        let current = resume.interrupt;
        let raw: unknown;
        // Each resolution extends the signed ledger. Advance from that updated
        // continuation; the program runs only after the last parked call settles.
        for (const [index, resolution] of resume.resolutions.entries()) {
          if (index > 0) {
            const advanced = module.unwrapCodeModeResult(raw, continuationSecurity);
            if (advanced.status !== "interrupted") {
              throw new Error("Workflow sandbox resumed before every parked call was resolved.");
            }
            current = pendingInterruptsOf(advanced.interrupt)[0] ?? advanced.interrupt;
          }
          raw = await module.continueCodeModeInterrupt({
            interrupt: current,
            options,
            resolution,
            tools: hostTools,
          } as never);
        }
        return classify(raw);
      }),
  };
}

/** A host tool that parks the program on first call and replays its resolution on resume. */
export function createParkingHostTool(input: {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly interrupt: (toolInput: unknown) => {
    readonly kind: string;
    readonly [key: string]: unknown;
  };
}): ToolSet[string] {
  return {
    description: input.description,
    inputSchema: jsonSchema(input.inputSchema),
    outputSchema: input.outputSchema === undefined ? undefined : jsonSchema(input.outputSchema),
    execute: async (toolInput: unknown, options: unknown) => {
      const module = await loadWorkflowSandboxModule();
      const resolution = readResolution(options);
      // Preserves a nested tool's failure message across the sandbox bridge.
      if (resolution?.status === "failed") throw new module.CodeModeToolError(resolution.error);
      if (resolution?.status === "completed") return resolution.output;
      return module.requestCodeModeInterrupt(input.interrupt(toolInput));
    },
  } as ToolSet[string];
}

/** Only program failures end the step successfully; infrastructure errors still retry. */
async function settle(
  execute: () => Promise<WorkflowSandboxOutcome>,
): Promise<WorkflowSandboxOutcome> {
  try {
    return await execute();
  } catch (error) {
    const message = readProgramFailure(error);
    if (message === undefined) throw error;
    return { status: "failed", error: message };
  }
}

function readProgramFailure(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const failure = error as { code?: unknown; message?: unknown };
  if (typeof failure.message !== "string") return undefined;
  switch (failure.code) {
    case "RUN_USER_SOURCE_ERROR":
    case "CODE_MODE_TOOL_ERROR":
    case "CODE_MODE_SOURCE_TOO_LARGE":
    case "CODE_MODE_BRIDGE_LIMIT":
    case "CODE_MODE_DETACHED_BRIDGE_REQUEST":
    case "CODE_MODE_SERIALIZATION_ERROR":
      return failure.message;
    default:
      return undefined;
  }
}

function readResolution(options: unknown): WorkflowSandboxResolution | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const interrupt = (options as Record<string, unknown>).codeModeInterrupt;
  if (typeof interrupt !== "object" || interrupt === null) return undefined;
  const resolution = (interrupt as Record<string, unknown>).resolution;
  if (typeof resolution !== "object" || resolution === null) return undefined;
  const { status } = resolution as { status?: unknown };
  return status === "completed" || status === "failed"
    ? (resolution as WorkflowSandboxResolution)
    : undefined;
}

/** Reconstructs every unresolved interruption from the authenticated continuation. */
function pendingInterruptsOf(interrupt: WorkflowSandboxInterrupt): WorkflowSandboxInterrupt[] {
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
    requestCodeModeInterrupt: module.experimental_requestCodeModeInterrupt,
    unwrapCodeModeResult: module.experimental_unwrapCodeModeResult,
  };
}
