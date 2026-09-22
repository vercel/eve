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
    const ask = vi.fn().mockResolvedValue({ optionId: "2", status: "answered" });

    expect(isWorkflowToolDefinition(definition)).toBe(true);
    expect(definition.description).toBe(ASK_QUESTION_TOOL_DESCRIPTION);
    await expect(definition.execute(colorQuestion, { ask } as never)).resolves.toEqual({
      answer: "Blue",
      status: "answered",
    });
    expect(ask).toHaveBeenCalledExactlyOnceWith(toAskQuestionRequest(colorQuestion));
  });

  it("accepts one question with at most three label and description options", () => {
    expect(ASK_QUESTION_INPUT_SCHEMA.safeParse(colorQuestion).success).toBe(true);
    expect(
      ASK_QUESTION_INPUT_SCHEMA.safeParse({ question: "What should we call it?" }).success,
    ).toBe(true);
    expect(
      ASK_QUESTION_INPUT_SCHEMA.safeParse({
        options: [colorQuestion.options[0]],
        question: "Only one choice?",
      }).success,
    ).toBe(false);
    expect(
      ASK_QUESTION_INPUT_SCHEMA.safeParse({
        options: [...colorQuestion.options, ...colorQuestion.options],
        question: "Too many choices?",
      }).success,
    ).toBe(false);
    expect(
      ASK_QUESTION_INPUT_SCHEMA.safeParse({
        options: colorQuestion.options.map((option, index) => ({ ...option, id: `${index}` })),
        question: colorQuestion.question,
      }).success,
    ).toBe(false);
    expect(
      ASK_QUESTION_INPUT_SCHEMA.safeParse({ ...colorQuestion, questions: [colorQuestion] }).success,
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
        { description: "Warm and bold.", id: "1", label: "Red (Recommended)" },
        { description: "Calm and cool.", id: "2", label: "Blue" },
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
    expect(toAskQuestionOutput(colorQuestion, { optionId: "1", status: "answered" })).toEqual({
      answer: "Red (Recommended)",
      status: "answered",
    });
    expect(toAskQuestionOutput(colorQuestion, { status: "answered", text: "Green" })).toEqual({
      answer: "Green",
      status: "answered",
    });
  });

  it("passes through dismissed and unavailable answers", () => {
    expect(toAskQuestionOutput(colorQuestion, { status: "dismissed" })).toEqual({
      status: "dismissed",
    });
    expect(toAskQuestionOutput(colorQuestion, { status: "unavailable" })).toEqual({
      status: "unavailable",
    });
  });
});
