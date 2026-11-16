import { programAgentCallWorkflowReference } from "#execution/code-mode/agent-call-reference.js";
import { callProgramAgent } from "#execution/code-mode/agent-call.js";
import {
  runWorkflowProgram,
  runWorkflowProgramTask,
} from "#execution/code-mode/workflow-program.js";
import { agentToolServeWorkflowReference } from "#runtime/subagents/workflow-reference.js";
import { serveAgentTool } from "#runtime/subagents/workflow.js";
import { askQuestionBody } from "#tools/provided/ask-question-body.js";
import { executeAskQuestionTool } from "#tools/provided/ask-question-workflow.js";
import { workflowBodyOf, type WorkflowBody } from "#tools/workflow-body.js";

/**
 * The workflow bodies eve itself registers with Workflow, as the plain functions a host without
 * Workflow runs: under Workflow's client transform a `"use workflow"` function is a stub. The
 * `agent` tool's workflow and a program's agent call have stable ids; `ask_question`'s and the
 * `workflow()` tool's are the ones their build stamped.
 */
export const FRAMEWORK_WORKFLOW_BODIES: readonly WorkflowBody[] = [
  { body: serveAgentTool, workflowId: agentToolServeWorkflowReference.workflowId },
  { body: callProgramAgent, workflowId: programAgentCallWorkflowReference.workflowId },
  workflowBodyOf(executeAskQuestionTool, askQuestionBody),
  workflowBodyOf(runWorkflowProgramTask, runWorkflowProgram),
].filter((body) => body !== undefined);
