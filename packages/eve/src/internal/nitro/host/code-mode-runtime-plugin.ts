import {
  CodeModeToolError,
  createCodeModeTool,
} from "#compiled/experimental-ai-sdk-code-mode/index.js";
import { installCodeModeRuntimeModule } from "#shared/code-mode-runtime.js";

installCodeModeRuntimeModule({ CodeModeToolError, createCodeModeTool });

export default function installCodeModeRuntimePlugin(): void {}
