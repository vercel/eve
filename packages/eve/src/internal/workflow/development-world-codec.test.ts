import { describe, expect, it } from "vitest";

import {
  decodeDevelopmentWorldValue,
  deserializeDevelopmentWorldError,
  encodeDevelopmentWorldValue,
  serializeDevelopmentWorldError,
} from "#internal/workflow/development-world-codec.js";

describe("development Workflow World codec", () => {
  it("preserves dates, bytes, and undefined values across the private transport", () => {
    const createdAt = new Date("2026-07-13T12:00:00.000Z");

    expect(
      decodeDevelopmentWorldValue(
        encodeDevelopmentWorldValue({
          createdAt,
          input: new Uint8Array([1, 2, 3]),
          output: undefined,
        }),
      ),
    ).toEqual({ createdAt, input: new Uint8Array([1, 2, 3]), output: undefined });
  });

  it("preserves ordinary objects that resemble codec markers", () => {
    const value = {
      bytes: { __eveDevelopmentWorldType: "uint8-array", data: "AQID" },
      date: {
        __eveDevelopmentWorldType: "date",
        data: "2026-07-13T12:00:00.000Z",
      },
      legacyBytes: { __type: "Uint8Array", data: "AQID" },
      nested: [{ __eveDevelopmentWorldType: "undefined" }],
    };

    expect(decodeDevelopmentWorldValue(encodeDevelopmentWorldValue(value))).toEqual(value);
  });

  it("preserves World error identity and retry metadata", () => {
    const source = Object.assign(new Error("try later"), {
      name: "WorkflowWorldError",
      retryAfter: 3,
    });

    const error = deserializeDevelopmentWorldError(serializeDevelopmentWorldError(source));

    expect(error).toMatchObject({
      message: "try later",
      name: "WorkflowWorldError",
      retryAfter: 3,
    });
  });
});
