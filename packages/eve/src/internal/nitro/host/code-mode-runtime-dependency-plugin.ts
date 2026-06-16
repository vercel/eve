import * as codeMode from "#compiled/experimental-ai-sdk-code-mode/index.js";
import { installCodeModeModule } from "#shared/code-mode.js";

installCodeModeModule(codeMode);

export default function installCodeModeRuntimeDependencyPlugin(): void {}
