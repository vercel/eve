import type * as RunModule from "#compiled/run/index.js";

const WORKFLOW_SANDBOX_MODULE_KEY = Symbol.for("eve.workflowSandbox.module");

type WorkflowSandboxModule = Pick<
  typeof RunModule,
  "createRunner" | "createSignedContinuationCodec" | "getHostFunctionContext" | "RunError"
>;

type WorkflowSandboxGlobal = typeof globalThis & {
  [WORKFLOW_SANDBOX_MODULE_KEY]?: WorkflowSandboxModule;
};

export function installWorkflowSandboxModule(module: WorkflowSandboxModule): void {
  (globalThis as WorkflowSandboxGlobal)[WORKFLOW_SANDBOX_MODULE_KEY] = module;
}

/**
 * Returns the vendored `run` runtime that executes generated programs. eve's
 * host installs it for agents with code mode on, so hosts without one never
 * bundle it.
 */
export async function loadWorkflowSandboxModule(): Promise<WorkflowSandboxModule> {
  const installed = (globalThis as WorkflowSandboxGlobal)[WORKFLOW_SANDBOX_MODULE_KEY];
  if (installed === undefined) {
    throw new Error(
      "The program runtime is not installed in this server. eve installs it only for agents whose manifest sets `codeMode: true`; rebuild with `eve build` after setting it.",
    );
  }
  return installed;
}
