import {
  continueCodeModeInterrupt,
  createCodeModeTool,
  getCodeModeInterrupt,
  requestCodeModeInterrupt,
  unwrapCodeModeResult,
} from "#compiled/experimental-ai-sdk-code-mode/index.js";
import { installWorkflowSandboxModule } from "#shared/workflow-sandbox.js";

installWorkflowSandboxModule({
  continueCodeModeInterrupt,
  createCodeModeTool,
  getCodeModeInterrupt,
  requestCodeModeInterrupt,
  unwrapCodeModeResult,
});

export default function installWorkflowSandboxRuntimePlugin(): void {}
