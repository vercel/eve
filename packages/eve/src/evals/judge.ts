import { evaluate } from "#ai/evaluate.js";
import { runUntilAborted } from "#evals/abort.js";
import type { AssertionCollector } from "#evals/assertions/collector.js";
import { formatDiagnosticValue, toDiagnosticMetadataValue } from "#evals/diagnostics.js";
import type {
  AssertionHandle,
  EveEvalJudgeConfig,
  JudgeBatch,
  JudgeContext,
  JudgeInput,
  JudgeOpts,
  JudgeQuestion,
  JudgeQuestionConstraint,
} from "#evals/types.js";

interface JudgeDeps {
  readonly collector: AssertionCollector;
  readonly getReply: () => string | null;
  readonly getInput: () => string;
  readonly judge: EveEvalJudgeConfig | undefined;
  readonly signal: AbortSignal;
}

/** Bind evaluation-backed judgments to the existing assertion lifecycle. */
export function buildJudgeContext(deps: JudgeDeps): JudgeContext {
  function judge(criteria: string, opts?: JudgeOpts): AssertionHandle;
  function judge<const Q extends JudgeQuestion>(
    question: Q & JudgeQuestionConstraint<Q>,
    opts?: JudgeOpts,
  ): AssertionHandle;
  function judge<const Questions extends Record<string, JudgeQuestion>>(
    batch: JudgeBatch<Questions>,
    opts?: EveEvalJudgeConfig,
  ): { readonly [Key in keyof Questions]: AssertionHandle };
  function judge(
    input: string | JudgeQuestion | JudgeBatch<Record<string, JudgeQuestion>>,
    opts?: JudgeOpts,
  ): AssertionHandle | Record<string, AssertionHandle> {
    const batch = typeof input === "object" && "questions" in input;
    const questions = batch
      ? input.questions
      : {
          judgment:
            typeof input === "string" ? { type: "boolean" as const, instructions: input } : input,
        };
    const entries = Object.entries(questions);
    if (entries.length === 0) throw new Error("Judge questions must be a non-empty map.");
    const state =
      batch && input.state !== undefined
        ? input.state
        : {
            input: deps.getInput(),
            output: !batch && opts?.on !== undefined ? opts.on : (deps.getReply() ?? ""),
          };
    const model = opts?.model ?? deps.judge?.model;
    const modelOptions = opts?.modelOptions ?? deps.judge?.modelOptions;
    const request = runUntilAborted(
      (async () => {
        const capturedState = structuredClone(state);
        const capturedQuestions = structuredClone(questions);
        const evaluationQuestions = Object.fromEntries(
          Object.entries(capturedQuestions).map(([id, question]) => {
            if (question.type !== "choice") return [id, question];
            const { expected, ...evaluationQuestion } = question;
            if (typeof expected !== "string" || !Object.hasOwn(question.criteria, expected)) {
              throw new Error(`Judge question "${id}" expected must name an option in criteria.`);
            }
            return [id, evaluationQuestion];
          }),
        );
        const result = await evaluate({
          model,
          state: capturedState,
          questions: evaluationQuestions,
          providerOptions: modelOptions?.providerOptions,
          abortSignal: deps.signal,
        });
        return { result, state: capturedState, questions: capturedQuestions };
      })(),
      deps.signal,
    );

    const handles = Object.fromEntries(
      entries.map(([id, question]) => [
        id,
        deps.collector.recordValue({
          name: `judge.${question.type}${batch ? `.${id}` : ""}`,
          severity: "soft",
          score: async () => {
            const { result, state, questions } = await request;
            const question = questions[id]!;
            const answer = result.answers[id]!;
            const score = judgeScore(question, answer);
            return {
              score,
              message: formatJudgeDetail(state, question, answer),
              metadata: {
                judge: result.response.modelId,
                questionId: id,
                question,
                state,
                answer,
                score,
                usage: result.usage,
                usageScope: batch ? "batch" : "assertion",
                warnings: result.warnings,
                rounding: result.rounding,
                providerMetadata: result.providerMetadata,
                response: toDiagnosticMetadataValue(result.response),
              },
            };
          },
        }),
      ]),
    );
    return batch ? handles : handles.judgment!;
  }
  return judge;
}

function formatJudgeDetail(state: JudgeInput, question: JudgeQuestion, answer: unknown): string {
  return [
    ["state", state],
    ["question", question],
    ["answer", answer],
  ]
    .map(([label, value]) => `${label}: ${formatDiagnosticValue(value)}`)
    .join("\n");
}

function judgeScore(
  question: JudgeQuestion,
  answer: Awaited<ReturnType<typeof evaluate>>["answers"][string],
): number {
  switch (answer.type) {
    case "boolean":
      return answer.probability;
    case "score":
      if (question.type === "score") return answer.score / (question.criteria.length - 1);
      break;
    case "choice":
      if (question.type === "choice") return answer.choice === question.expected ? 1 : 0;
      break;
  }
  throw new Error("Evaluation answer does not match the judge question.");
}
