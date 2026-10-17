import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inputResponseSchema } from "#shared/input.js";

describe("inputResponseSchema decline", () => {
  it.each([{ optionId: "approve" }, { text: "answer" }, { optionId: "approve", text: "answer" }])(
    "rejects decline with an answer %j",
    (answer) => {
      expect(
        inputResponseSchema.safeParse({ requestId: "q", decline: true, ...answer }).success,
      ).toBe(false);
    },
  );
  it("accepts exclusive declines and ordinary answers and converts to JSON Schema", () => {
    expect(inputResponseSchema.parse({ requestId: "q", decline: true })).toEqual({
      requestId: "q",
      decline: true,
    });
    expect(
      inputResponseSchema.safeParse({ requestId: "q", optionId: "approve", text: "note" }).success,
    ).toBe(true);
    expect(z.toJSONSchema(inputResponseSchema).type).toBe("object");
  });
});
