import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

/** What the judge reads: the objective and the evidence one turn surfaced. */
export interface GoalJudgeInput {
  readonly objective: string;
  /** What the turn was asked: a person's message, or the goal's own continuation. */
  readonly input: string;
  /** The turn's reply text. */
  readonly reply: string;
  /** The turn's settled tool calls, with their inputs and outputs. */
  readonly calls: readonly {
    readonly name: string;
    readonly state: string;
    readonly input?: unknown;
    readonly output?: unknown;
  }[];
  readonly abortSignal: AbortSignal;
}

/**
 * The judge's verdict. `reason` steers the next turn when the goal continues, and records why it
 * stopped otherwise.
 */
export interface GoalVerdict {
  readonly verdict: "met" | "continue" | "impossible";
  readonly reason: string;
}

export type GoalJudge = (input: GoalJudgeInput) => Promise<GoalVerdict>;

const verdictSchema = z.object({
  verdict: z.enum(["met", "continue", "impossible"]),
  reason: z.string().min(1).max(2_000),
});

const MAX_EVIDENCE_CHARS = 24_000;

const SYSTEM = [
  "You judge whether an agent has met a goal, from the evidence of its latest turn.",
  'Answer "met" only when the evidence shows the goal is fully met. Claims without evidence do not count.',
  'Answer "impossible" only when the evidence shows the goal can\'t be met, or the person asked to stop or abandon it.',
  'Otherwise answer "continue". Then `reason` tells the agent, in one or two sentences, the most important thing still missing and what to do next.',
  "If the person changed direction, judge against the goal and say so in `reason`.",
].join("\n");

/** Asks `model` for a verdict with structured output. */
export function modelJudge(model: string | LanguageModel): GoalJudge {
  return async (input) => {
    const result = await generateText({
      abortSignal: input.abortSignal,
      model,
      output: Output.object({ schema: verdictSchema }),
      prompt: judgePrompt(input),
      system: SYSTEM,
    });
    return verdictSchema.parse(result.output);
  };
}

/** The objective and the turn's evidence, trimmed from the oldest calls to fit. */
export function judgePrompt(input: Omit<GoalJudgeInput, "abortSignal">): string {
  const head = [
    `<goal>${input.objective}</goal>`,
    `<turn_input>${input.input}</turn_input>`,
    `<turn_reply>${input.reply}</turn_reply>`,
  ].join("\n");
  const calls: string[] = [];
  let budget = MAX_EVIDENCE_CHARS - head.length;
  for (const call of [...input.calls].reverse()) {
    const line = `<call name=${JSON.stringify(call.name)} state=${JSON.stringify(call.state)}>${JSON.stringify(
      { input: call.input, output: call.output },
    )}</call>`;
    if (line.length > budget) break;
    calls.unshift(line);
    budget -= line.length;
  }
  const omitted = input.calls.length - calls.length;
  return [
    head,
    `<turn_calls${omitted > 0 ? ` omitted_earlier="${omitted}"` : ""}>`,
    ...calls,
    "</turn_calls>",
  ].join("\n");
}
