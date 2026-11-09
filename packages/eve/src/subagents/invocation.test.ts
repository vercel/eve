import { describe, expect, it } from "vitest";

import { formatSubagentInput, normalizeRequestedOutputSchema } from "#subagents/invocation.js";

it("keeps delegated attachment parts after the child instructions", () => {
  const result = formatSubagentInput({
    type: "local",
    name: "reviewer",
    description: "Review reports",
    message: [
      { type: "text", text: "Review Alice's report." },
      { type: "file", data: "https://files.example/report.pdf", mediaType: "application/pdf" },
    ],
  });
  expect(result.message).toEqual([
    { type: "text", text: expect.stringContaining('You are the subagent "reviewer".') },
    { type: "text", text: "Review Alice's report." },
    { type: "file", data: "https://files.example/report.pdf", mediaType: "application/pdf" },
  ]);
});

describe("normalizeRequestedOutputSchema", () => {
  it("passes a non-empty object schema through", () => {
    const schema = { properties: { answer: { type: "string" } }, type: "object" };

    expect(normalizeRequestedOutputSchema(schema)).toBe(schema);
  });

  it.each([
    ["an empty object", {}],
    ["a string", "object"],
    ["a number", 7],
    ["null", null],
    ["an array", [{ type: "object" }]],
  ])("normalizes %s to undefined", (_label, value) => {
    expect(normalizeRequestedOutputSchema(value)).toBeUndefined();
  });

  it("normalizes an absent value to undefined", () => {
    expect(normalizeRequestedOutputSchema(undefined)).toBeUndefined();
  });
});
