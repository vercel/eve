import type { DecisionQuestion } from "#ai/decision-types.js";

export type DecisionResultRecord =
  | { question_index: number; question_name: string; type: "predicate"; probability: number }
  | {
      question_index: number;
      question_name: string;
      type: "choice";
      value: string;
      probability?: number;
    }
  | {
      question_index: number;
      question_name: string;
      type: "score";
      value: number;
      levels: string[];
    }
  | { question_index: number; question_name: string; type: "refusal" };

export function decisionResults(
  questions: Readonly<Record<string, DecisionQuestion>>,
  outcome:
    | { readonly answers: Readonly<Record<string, unknown>> }
    | { readonly refused: readonly string[] },
): DecisionResultRecord[] {
  return Object.entries(questions).flatMap(([name, question], index): DecisionResultRecord[] => {
    const base = { question_index: index, question_name: name };
    if ("refused" in outcome) {
      return outcome.refused.includes(name) ? [{ ...base, type: "refusal" }] : [];
    }
    const answer = outcome.answers[name] as Record<string, unknown> | undefined;
    if (answer?.type === "refusal") return [{ ...base, type: "refusal" }];
    if (answer?.type !== question.type) return [];
    if (question.type === "boolean" && typeof answer.probability === "number") {
      return [{ ...base, type: "predicate", probability: answer.probability }];
    }
    if (question.type === "choice" && typeof answer.choice === "string") {
      const result: DecisionResultRecord = { ...base, type: "choice", value: answer.choice };
      const probability = (answer.probabilities as Record<string, unknown> | undefined)?.[
        answer.choice
      ];
      if (typeof probability === "number") result.probability = probability;
      return [result];
    }
    if (question.type === "score" && typeof answer.score === "number") {
      const levels = question.criteria;
      if (levels.length < 2 || !levels.every((level) => typeof level === "string")) return [];
      return [{ ...base, type: "score", value: answer.score, levels: [...levels] }];
    }
    return [];
  });
}
