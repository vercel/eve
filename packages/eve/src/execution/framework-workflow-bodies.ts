import { programAgentCallWorkflowReference } from "#execution/code-mode/agent-call-reference.js";
import { callProgramAgent } from "#execution/code-mode/agent-call.js";
import {
  runWorkflowProgram,
  runWorkflowProgramExecute,
  runWorkflowProgramTask,
} from "#execution/dynamic-workflow/tool.js";
import { agentToolServeWorkflowReference } from "#runtime/subagents/workflow-reference.js";
import { serveAgentTool } from "#runtime/subagents/workflow.js";
import { askQuestionBody } from "#tools/provided/ask-question-body.js";
import { executeAskQuestionTool } from "#tools/provided/ask-question-workflow.js";
import { workflowBodyOf, type WorkflowBody } from "#tools/workflow-body.js";

export const FRAMEWORK_WORKFLOW_BODIES: readonly WorkflowBody[] = [
  { body: serveAgentTool, workflowId: agentToolServeWorkflowReference.workflowId },
  { body: callProgramAgent, workflowId: programAgentCallWorkflowReference.workflowId },
  workflowBodyOf(executeAskQuestionTool, askQuestionBody),
  workflowBodyOf(runWorkflowProgramTask, runWorkflowProgram),
  workflowBodyOf(runWorkflowProgramExecute, runWorkflowProgram),
].filter((body) => body !== undefined);
