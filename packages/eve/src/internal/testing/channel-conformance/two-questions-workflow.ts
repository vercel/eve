import type { ToolInputResponse, WorkflowToolContext } from "#public/tools/index.js";

export const DAY_PROMPT = "Which day works for the review?";
export const TIME_PROMPT = "Which time works for the review?";
export const RETRO_PROMPT = "Which day suits the retro?";

/**
 * Asks two questions at once, so both are pending together. The test tier's
 * bundler registers this `"use workflow"` body, as it would an app's tool.
 */
export async function askDayAndTimeWorkflow(
  _input: unknown,
  ctx: WorkflowToolContext,
): Promise<{ readonly day: string; readonly time: string }> {
  "use workflow";

  const [day, time] = await Promise.all([
    ctx.ask({ display: "select", options: choices("Saturday", "Sunday"), prompt: DAY_PROMPT }),
    ctx.ask({ display: "select", options: choices("Morning", "Afternoon"), prompt: TIME_PROMPT }),
  ]);
  return { day: summarize(day), time: summarize(time) };
}

/**
 * Asks one question that takes no free text, so a message that matches no option
 * steers the turn instead of answering it.
 */
export async function askRetroDayWorkflow(
  _input: unknown,
  ctx: WorkflowToolContext,
): Promise<{ readonly day: string }> {
  "use workflow";

  const day = await ctx.ask({
    display: "select",
    options: choices("Thursday", "Friday"),
    prompt: RETRO_PROMPT,
  });
  return { day: summarize(day) };
}

function choices(...labels: string[]) {
  return labels.map((label) => ({ id: label, label }));
}

function summarize(answer: ToolInputResponse): string {
  return answer.status === "answered" ? (answer.optionId ?? answer.text ?? "") : answer.status;
}
