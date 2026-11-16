import {
  createRunner,
  createSignedContinuationCodec,
  getHostFunctionContext,
  RunError,
} from "#compiled/run/index.js";
import { installWorkflowSandboxModule } from "#shared/workflow-sandbox.js";

/** Installs the `run` runtime that agents with a generated-program tool execute programs in. */
export function installWorkflowSandboxRuntime(): void {
  installWorkflowSandboxModule({
    createRunner,
    createSignedContinuationCodec,
    getHostFunctionContext,
    RunError,
  });
}
