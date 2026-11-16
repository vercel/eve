import { agentToolServeWorkflowReference } from "#runtime/subagents/workflow-reference.js";
import { serveAgentTool } from "#runtime/subagents/workflow.js";
import { askQuestionBody } from "#tools/provided/ask-question-body.js";
import { executeAskQuestionTool } from "#tools/provided/ask-question-workflow.js";
import { workflowBodyOf, type WorkflowBody } from "#tools/workflow-body.js";

/**
 * The workflow bodies eve itself registers with Workflow, as the plain functions a host without
 * Workflow runs: under Workflow's client transform a `"use workflow"` function is a stub. The
 * `agent` tool's workflow has a stable id; `ask_question`'s is the one its build stamped.
 */
export const FRAMEWORK_WORKFLOW_BODIES: readonly WorkflowBody[] = [
  { body: serveAgentTool, workflowId: agentToolServeWorkflowReference.workflowId },
  workflowBodyOf(executeAskQuestionTool, askQuestionBody),
].filter((body) => body !== undefined);
