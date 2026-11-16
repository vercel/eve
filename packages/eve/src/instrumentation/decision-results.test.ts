import { describe, expect, it } from "vitest";

import type { DecisionQuestion } from "#ai/decision-types.js";
import { decisionResults } from "#instrumentation/decision-results.js";

const questions = {
  team: {
    type: "choice",
    instructions: "Select the team that can help Alice.",
    criteria: { billing: "Invoices", support: "Product questions" },
  },
  urgent: { type: "boolean", instructions: "Does Alice need an urgent response?" },
  severity: {
    type: "score",
    instructions: "How severe is Alice's issue?",
    criteria: ["Cosmetic", "Workaround available", "Fully blocked"],
  },
} satisfies Record<string, DecisionQuestion>;

describe("decisionResults", () => {
  it("records each answer by its request position in the GenAI results shape", () => {
    expect(
      decisionResults(questions, {
        answers: {
          team: {
            type: "choice",
            choice: "billing",
            probabilities: { billing: 0.72, support: 0.28 },
          },
          urgent: { type: "boolean", probability: 0.2 },
          severity: { type: "score", score: 1.43 },
        },
      }),
    ).toEqual([
      {
        question_index: 0,
        question_name: "team",
        type: "choice",
        value: "billing",
        probability: 0.72,
      },
      { question_index: 1, question_name: "urgent", type: "predicate", probability: 0.2 },
      {
        question_index: 2,
        question_name: "severity",
        type: "score",
        value: 1.43,
        levels: ["Cosmetic", "Workaround available", "Fully blocked"],
      },
    ]);
  });

  it("records refused questions without renumbering the rest", () => {
    expect(decisionResults(questions, { refused: ["urgent"] })).toEqual([
      { question_index: 1, question_name: "urgent", type: "refusal" },
    ]);
  });

  it("omits answers it can't record faithfully", () => {
    expect(
      decisionResults(
        {
          ...questions,
          severity: { ...questions.severity, criteria: ["Cosmetic", null, { level: "blocked" }] },
        },
        {
          answers: {
            team: { type: "choice", choice: "billing" },
            urgent: { type: "unknown" },
            severity: { type: "score", score: 1 },
          },
        },
      ),
    ).toEqual([{ question_index: 0, question_name: "team", type: "choice", value: "billing" }]);
  });
});
