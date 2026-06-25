import * as workflowSandbox from "#compiled/experimental-ai-sdk-code-mode/index.js";
import { installWorkflowSandboxModule } from "#shared/workflow-sandbox.js";

installWorkflowSandboxModule(workflowSandbox);

export default function installWorkflowSandboxRuntimePlugin(): void {}
