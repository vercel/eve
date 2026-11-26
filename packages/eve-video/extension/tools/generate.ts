import { defineWorkflowTool, toolOutput } from "eve/tools";
import { createWebhook, FatalError, getWorkflowMetadata, sleep } from "eve/workflow";

import extension from "../extension.ts";
import {
  VIDEO_TOOL_DESCRIPTION,
  createGenerateApproval,
  formatGenerateCompleteLabel,
  formatGenerateProgressLabel,
  generateVideoInputSchema,
} from "../lib/tools.ts";
import { runVideoWorkflowTask } from "../lib/workflow-runner.ts";
import {
  checkAndPersistStep,
  cleanupStagedInputsStep,
  submitVideoStep,
  verifyAndRespondWebhookStep,
} from "../lib/workflow-steps.ts";

/** Generates videos in the background as a durable workflow task using the configured video model and storage. */
export default defineWorkflowTool({
  description: VIDEO_TOOL_DESCRIPTION,
  inputSchema: generateVideoInputSchema,
  approval: createGenerateApproval(() => extension.config),
  async *task(input, ctx) {
    "use workflow";
    return yield* runVideoWorkflowTask(
      {
        submit: submitVideoStep,
        checkAndPersist: checkAndPersistStep,
        verifyAndRespondWebhook: verifyAndRespondWebhookStep,
        cleanup: cleanupStagedInputsStep,
        createWebhook,
        getWorkflowMetadata,
        sleep,
        createFatalError: (message) => new FatalError(message),
      },
      input,
      ctx,
    );
  },
  label: {
    start: () => "Generating video",
    delta: (_input, partial) => formatGenerateProgressLabel(partial),
    complete: (_input, output) => formatGenerateCompleteLabel(output),
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
