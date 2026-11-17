import {
  createRunner,
  createSignedContinuationCodec,
  getHostFunctionContext,
  RunError,
} from "#compiled/run/index.js";
import { installWorkflowSandboxModule } from "#shared/workflow-sandbox.js";

export function installWorkflowSandboxRuntime(): void {
  installWorkflowSandboxModule({
    createRunner,
    createSignedContinuationCodec,
    getHostFunctionContext,
    RunError,
  });
}
