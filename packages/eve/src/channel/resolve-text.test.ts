import { describe, expect, it } from "vitest";
import type { InteractionRequest } from "#protocol/session-events/families/interaction.js";
import { answerFromText } from "#channel/resolve-text.js";

const asked = (interactionId: string, request: InteractionRequest) => ({ interactionId, request });

const APPROVAL_REQUEST = asked("req-1", {
  allowFreeform: false,
  display: "confirmation",
  kind: "approval",
  options: [
    { id: "approve", label: "Approve", style: "primary" },
    { id: "cancel", label: "Cancel", style: "danger" },
  ],
  prompt: 'Approve tool "bash"?',
});

const SELECT_REQUEST = asked("req-2", {
  display: "select",
  kind: "question",
  options: [
    { id: "postgres", label: "Postgres" },
    { id: "mysql", label: "MySQL" },
    { id: "sqlite", label: "SQLite" },
  ],
  prompt: "Which database?",
});

const FREEFORM_REQUEST = asked("req-3", {
  allowFreeform: true,
  display: "text",
  kind: "question",
  prompt: "What is your name?",
});

const SELECT_WITH_FREEFORM_REQUEST = asked("req-4", {
  allowFreeform: true,
  display: "select",
  kind: "question",
  options: [
    { id: "red", label: "Red" },
    { id: "blue", label: "Blue" },
  ],
  prompt: "Pick a color or enter a custom one.",
});

describe("answerFromText", () => {
  it("returns undefined for empty text", () => {
    expect(answerFromText("", APPROVAL_REQUEST)).toBeUndefined();
  });

  it("returns undefined for whitespace-only text", () => {
    expect(answerFromText("   ", APPROVAL_REQUEST)).toBeUndefined();
  });

  it("matches option by exact ID (case-insensitive)", () => {
    expect(answerFromText("approve", APPROVAL_REQUEST)).toEqual({
      interactionId: "req-1",
      optionId: "approve",
    });
    expect(answerFromText("APPROVE", APPROVAL_REQUEST)).toEqual({
      interactionId: "req-1",
      optionId: "approve",
    });
  });

  it("matches option by exact label (case-insensitive)", () => {
    expect(answerFromText("Postgres", SELECT_REQUEST)).toEqual({
      interactionId: "req-2",
      optionId: "postgres",
    });
    expect(answerFromText("mysql", SELECT_REQUEST)).toEqual({
      interactionId: "req-2",
      optionId: "mysql",
    });
  });

  it("matches option by 1-based numeric index", () => {
    expect(answerFromText("1", SELECT_REQUEST)).toEqual({
      interactionId: "req-2",
      optionId: "postgres",
    });
    expect(answerFromText("3", SELECT_REQUEST)).toEqual({
      interactionId: "req-2",
      optionId: "sqlite",
    });
  });

  it("does not match out-of-range numeric index", () => {
    expect(answerFromText("0", SELECT_REQUEST)).toBeUndefined();
    expect(answerFromText("4", SELECT_REQUEST)).toBeUndefined();
  });

  it("returns undefined when text does not match any option and freeform is disabled", () => {
    expect(answerFromText("yes", APPROVAL_REQUEST)).toBeUndefined();
    expect(answerFromText("sure", APPROVAL_REQUEST)).toBeUndefined();
    expect(answerFromText("maybe", SELECT_REQUEST)).toBeUndefined();
  });

  it("falls back to freeform text when allowFreeform is true", () => {
    expect(answerFromText("Alice", FREEFORM_REQUEST)).toEqual({
      interactionId: "req-3",
      text: "Alice",
    });
  });

  it("matches option first, freeform second when both available", () => {
    expect(answerFromText("red", SELECT_WITH_FREEFORM_REQUEST)).toEqual({
      interactionId: "req-4",
      optionId: "red",
    });
    expect(answerFromText("green", SELECT_WITH_FREEFORM_REQUEST)).toEqual({
      interactionId: "req-4",
      text: "green",
    });
  });

  it("falls back to freeform for requests with no options", () => {
    const noOptions = asked("req-5", { kind: "question", prompt: "Tell me something." });
    expect(answerFromText("anything", noOptions)).toEqual({
      interactionId: "req-5",
      text: "anything",
    });
  });

  it("trims whitespace from input", () => {
    expect(answerFromText("  approve  ", APPROVAL_REQUEST)).toEqual({
      interactionId: "req-1",
      optionId: "approve",
    });
  });
});
