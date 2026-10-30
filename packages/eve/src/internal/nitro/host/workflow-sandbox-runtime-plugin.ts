import {
  createRunner,
  createSignedContinuationCodec,
  getHostFunctionContext,
  RunError,
} from "#compiled/run/index.js";
import { installWorkflowSandboxModule } from "#shared/workflow-sandbox.js";

installWorkflowSandboxModule({
  createRunner,
  createSignedContinuationCodec,
  getHostFunctionContext,
  RunError,
});

export default function installWorkflowSandboxRuntimePlugin(): void {}
