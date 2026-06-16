import { describe, expect, it } from "vitest";

import { extractCompletedResult, normalizeOutputSchemaForRequest } from "#client/output-schema.js";
import {
  createResultCompletedEvent,
  createTurnCompletedEvent,
  type HandleMessageStreamEvent,
} from "#protocol/message.js";

describe("output schema client helpers", () => {
  it("normalizes raw JSON Schema objects for request bodies", () => {
    const schema = {
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
      type: "object",
    } as const;

    expect(normalizeOutputSchemaForRequest(schema)).toEqual(schema);
  });

  it("extracts the most recent completed structured result", () => {
    const events: HandleMessageStreamEvent[] = [
      createResultCompletedEvent({
        result: { title: "First" },
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      }),
      createTurnCompletedEvent({ sequence: 0, turnId: "turn_0" }),
      createResultCompletedEvent({
        result: { title: "Second" },
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ];

    expect(extractCompletedResult<{ title: string }>(events)).toEqual({ title: "Second" });
  });
});
