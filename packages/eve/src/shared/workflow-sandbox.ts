import type * as RunModule from "#compiled/run/index.js";

const WORKFLOW_SANDBOX_MODULE_KEY = Symbol.for("eve.workflowSandbox.module");
const WORKFLOW_SANDBOX_MODULE_SPECIFIER = ["#compiled", "run", "index.js"].join("/");

type WorkflowSandboxModule = Pick<
  typeof RunModule,
  "createRunner" | "createSignedContinuationCodec" | "getHostFunctionContext" | "RunError"
>;

type WorkflowSandboxGlobal = typeof globalThis & {
  [WORKFLOW_SANDBOX_MODULE_KEY]?: WorkflowSandboxModule;
};

let workflowSandboxModulePromise: Promise<WorkflowSandboxModule> | undefined;

export function installWorkflowSandboxModule(module: WorkflowSandboxModule): void {
  (globalThis as WorkflowSandboxGlobal)[WORKFLOW_SANDBOX_MODULE_KEY] = module;
}

/** Returns the vendored `run` runtime that executes generated workflow programs. */
export async function loadWorkflowSandboxModule(): Promise<WorkflowSandboxModule> {
  const installed = (globalThis as WorkflowSandboxGlobal)[WORKFLOW_SANDBOX_MODULE_KEY];
  if (installed !== undefined) return installed;

  workflowSandboxModulePromise ??= import(WORKFLOW_SANDBOX_MODULE_SPECIFIER) as Promise<
    typeof RunModule
  >;
  return await workflowSandboxModulePromise;
}
