import {
  experimental_continueCodeModeInterrupt as continueCodeModeInterrupt,
  experimental_createCodeModeTool as createCodeModeTool,
  experimental_getCodeModeInterrupt as getCodeModeInterrupt,
  experimental_requestCodeModeInterrupt as requestCodeModeInterrupt,
  experimental_unwrapCodeModeResult as unwrapCodeModeResult,
} from "#compiled/@ai-sdk/code-mode/index.js";
import { installWorkflowSandboxModule } from "#shared/workflow-sandbox.js";

installWorkflowSandboxModule({
  continueCodeModeInterrupt,
  createCodeModeTool,
  getCodeModeInterrupt,
  requestCodeModeInterrupt,
  unwrapCodeModeResult,
});

export default function installWorkflowSandboxRuntimePlugin(): void {}
