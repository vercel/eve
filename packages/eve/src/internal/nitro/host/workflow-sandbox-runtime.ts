import {
  createRunner,
  createSignedContinuationCodec,
  getHostFunctionContext,
  RunError,
} from "#compiled/run/index.js";
import { installWorkflowSandboxModule } from "#shared/workflow-sandbox.js";

/** Installs the `run` runtime that agents with code mode on execute programs in. */
export function installWorkflowSandboxRuntime(): void {
  installWorkflowSandboxModule({
    createRunner,
    createSignedContinuationCodec,
    getHostFunctionContext,
    RunError,
  });
}
