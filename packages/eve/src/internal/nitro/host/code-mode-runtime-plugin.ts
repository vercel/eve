import {
  CodeModeToolError,
  experimental_createCodeModeTool,
  experimental_runCodeMode,
} from "#compiled/@ai-sdk/code-mode/index.js";
import { installCodeModeRuntimeModule } from "#shared/code-mode-runtime.js";

installCodeModeRuntimeModule({
  CodeModeToolError,
  experimental_createCodeModeTool,
  experimental_runCodeMode,
});

export default function installCodeModeRuntimePlugin(): void {}
