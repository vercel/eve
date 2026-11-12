import type { ToolAnswer, WorkflowToolContext } from "#public/tools/index.js";
import { workflowBodyOf, type WorkflowBody } from "#tools/workflow-body.js";

export const DAY_PROMPT = "Which day works for the review?";
export const TIME_PROMPT = "Which time works for the review?";
export const RETRO_PROMPT = "Which day suits the retro?";

/**
 * Asks two questions at once, so both are pending together. The test tier's
 * bundler registers its `"use workflow"` twin, as it would an app's tool; the
 * in-process host runs this plain body.
 */
async function askDayAndTime(
  _input: unknown,
  ctx: WorkflowToolContext,
): Promise<{ readonly day: string; readonly time: string }> {
  const [day, time] = await Promise.all([
    ctx.ask({ display: "select", options: choices("Saturday", "Sunday"), prompt: DAY_PROMPT }),
    ctx.ask({ display: "select", options: choices("Morning", "Afternoon"), prompt: TIME_PROMPT }),
  ]);
  return { day: summarize(day), time: summarize(time) };
}

export async function askDayAndTimeWorkflow(
  input: unknown,
  ctx: WorkflowToolContext,
): Promise<{ readonly day: string; readonly time: string }> {
  "use workflow";

  return await askDayAndTime(input, ctx);
}

/**
 * Asks one question that takes no free text, so a message that matches no option
 * steers the turn instead of answering it.
 */
async function askRetroDay(
  _input: unknown,
  ctx: WorkflowToolContext,
): Promise<{ readonly day: string }> {
  const day = await ctx.ask({
    display: "select",
    options: choices("Thursday", "Friday"),
    prompt: RETRO_PROMPT,
  });
  return { day: summarize(day) };
}

export async function askRetroDayWorkflow(
  input: unknown,
  ctx: WorkflowToolContext,
): Promise<{ readonly day: string }> {
  "use workflow";

  return await askRetroDay(input, ctx);
}

/**
 * The workflows' ids as the test tier's bundler names them: this module's path in the package and
 * the function's name (`workflow-transformer.ts`). The test process imports this module
 * untransformed, so its functions carry no stamped id of their own.
 */
const workflowIdOf = (name: string) =>
  `workflow//./src/internal/testing/channel-conformance/question-workflows//${name}`;

/** The bodies above as a host without Workflow runs them, under their workflows' ids. */
export const QUESTION_WORKFLOW_BODIES: readonly WorkflowBody[] = [
  workflowBodyOf(askDayAndTimeWorkflow, askDayAndTime) ?? {
    body: askDayAndTime,
    workflowId: workflowIdOf("askDayAndTimeWorkflow"),
  },
  workflowBodyOf(askRetroDayWorkflow, askRetroDay) ?? {
    body: askRetroDay,
    workflowId: workflowIdOf("askRetroDayWorkflow"),
  },
];

function choices(...labels: string[]) {
  return labels.map((label) => ({ id: label, label }));
}

function summarize(answer: ToolAnswer): string {
  return answer.status === "answered" ? (answer.optionId ?? answer.text ?? "") : answer.status;
}
