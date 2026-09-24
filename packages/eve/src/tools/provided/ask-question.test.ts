import { describe, expect, it, vi } from "vitest";

import {
  ASK_QUESTION_INPUT_SCHEMA,
  ASK_QUESTION_TOOL_DESCRIPTION,
} from "#execution/tools/ask-question.js";
import {
  toAskQuestionOutput,
  toAskQuestionRequest,
} from "#execution/tools/ask-question-workflow.js";
import { askQuestion } from "#tools/provided/ask-question.js";
import { isWorkflowToolDefinition } from "#tools/workflow-definition.js";

function accepts(value: unknown): boolean {
  const result = ASK_QUESTION_INPUT_SCHEMA["~standard"].validate(value);
  if (result instanceof Promise) throw new Error("Expected synchronous validation.");
  return result.issues === undefined;
}

const colorQuestion = {
  options: [
    { description: "Warm and bold.", label: "Red (Recommended)" },
    { description: "Calm and cool.", label: "Blue" },
  ],
  question: "Which color should the banner use?",
};

describe("askQuestion", () => {
  it("defines a blocking workflow tool that asks through ctx.ask()", async () => {
    const definition = askQuestion();
    const ask = vi.fn().mockResolvedValue({ optionId: "Blue", status: "answered" });

    expect(isWorkflowToolDefinition(definition)).toBe(true);
    expect(definition.attached).toBe(true);
    expect(definition.description).toBe(ASK_QUESTION_TOOL_DESCRIPTION);
    await expect(definition.execute(colorQuestion, { ask } as never)).resolves.toEqual({
      answer: "Blue",
      status: "answered",
    });
    expect(ask).toHaveBeenCalledExactlyOnceWith(toAskQuestionRequest(colorQuestion));
  });

  it("accepts one question with at most three label and description options", () => {
    expect(accepts(colorQuestion)).toBe(true);
    expect(accepts({ question: "What should we call it?" })).toBe(true);
    expect(
      accepts({
        options: [colorQuestion.options[0]],
        question: "Only one choice?",
      }),
    ).toBe(false);
    expect(
      accepts({
        options: [...colorQuestion.options, ...colorQuestion.options],
        question: "Too many choices?",
      }),
    ).toBe(false);
    expect(
      accepts({
        options: colorQuestion.options.map((option, index) => ({ ...option, id: `${index}` })),
        question: colorQuestion.question,
      }),
    ).toBe(false);
    expect(accepts({ ...colorQuestion, questions: [colorQuestion] })).toBe(false);
    expect(
      accepts({
        options: [colorQuestion.options[1], colorQuestion.options[1]],
        question: "Blue or blue?",
      }),
    ).toBe(false);
  });
});

describe("toAskQuestionRequest", () => {
  it("always allows free text and lets the user move on", () => {
    expect(toAskQuestionRequest(colorQuestion)).toEqual({
      allowFreeform: true,
      dismissible: true,
      display: "select",
      options: [
        { description: "Warm and bold.", id: "Red (Recommended)", label: "Red (Recommended)" },
        { description: "Calm and cool.", id: "Blue", label: "Blue" },
      ],
      prompt: "Which color should the banner use?",
    });
    expect(toAskQuestionRequest({ question: "What should we call it?" })).toEqual({
      allowFreeform: true,
      dismissible: true,
      display: "text",
      prompt: "What should we call it?",
    });
  });
});

describe("toAskQuestionOutput", () => {
  it("returns the chosen label or the user's own words", () => {
    expect(toAskQuestionOutput({ optionId: "Red (Recommended)", status: "answered" })).toEqual({
      answer: "Red (Recommended)",
      status: "answered",
    });
    expect(toAskQuestionOutput({ status: "answered", text: "Green" })).toEqual({
      answer: "Green",
      status: "answered",
    });
  });

  it("passes through dismissed and unavailable answers", () => {
    expect(toAskQuestionOutput({ status: "dismissed" })).toEqual({
      status: "dismissed",
    });
    expect(toAskQuestionOutput({ status: "unavailable" })).toEqual({
      status: "unavailable",
    });
  });
});
