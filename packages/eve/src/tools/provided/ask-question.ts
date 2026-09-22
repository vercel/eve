import { defineWorkflowTool, type WorkflowToolDefinition } from "#tools/workflow-definition.js";
import {
  ASK_QUESTION_INPUT_SCHEMA,
  ASK_QUESTION_OUTPUT_SCHEMA,
  ASK_QUESTION_TOOL_DESCRIPTION,
  executeAskQuestionTool,
  type AskQuestionInput,
  type AskQuestionOutput,
} from "#execution/tools/ask-question.js";

export type { AskQuestionInput, AskQuestionOutput };

/**
 * Defines the opt-in `ask_question` tool.
 *
 * Export it from `agent/tools/ask_question.ts`:
 *
 * ```ts
 * import { askQuestion } from "eve/tools/ask_question";
 *
 * export default askQuestion();
 * ```
 *
 * Each call runs as a durable workflow that asks through `ctx.ask()`, so the
 * turn waits for the answer without holding an application runtime open.
 */
export function askQuestion(): WorkflowToolDefinition<AskQuestionInput, AskQuestionOutput> {
  return defineWorkflowTool({
    description: ASK_QUESTION_TOOL_DESCRIPTION,
    execute: executeAskQuestionTool,
    inputSchema: ASK_QUESTION_INPUT_SCHEMA,
    outputSchema: ASK_QUESTION_OUTPUT_SCHEMA,
  });
}
