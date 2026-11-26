import { defineWorkflowTool, toolOutput } from "eve/tools";
import { createWebhook, getWorkflowMetadata, sleep } from "eve/workflow";

import extension from "../extension.ts";
import * as tools from "../lib/tools.ts";
import { runVideoWorkflowTask } from "../lib/workflow-runner.ts";
import {
  checkAndPersistStep,
  cleanupStagedInputsStep,
  submitVideoStep,
  verifyAndRespondWebhookStep,
} from "../lib/workflow-steps.ts";

/** Generates videos in the background as a durable workflow task using the configured video model and storage. */
export default defineWorkflowTool({
  description: tools.VIDEO_TOOL_DESCRIPTION,
  inputSchema: tools.generateVideoInputSchema,
  approval: tools.createGenerateApproval(() => extension.config),
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
      },
      input,
      ctx,
    );
  },
  label: {
    start: () => "Generating video",
    delta: (_input, partial) => tools.formatGenerateProgressLabel(partial),
    complete: (_input, output) => tools.formatGenerateCompleteLabel(output),
  },
  toModelOutput: (output) => toolOutput.json(output),
});
