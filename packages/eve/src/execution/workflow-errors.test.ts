import { describe, expect, it } from "vitest";

import {
  normalizeSerializableError,
  rebuildSerializableError,
} from "#execution/workflow-errors.js";

describe("workflow-errors", () => {
  it("normalizes Errors into workflow-serializable objects", () => {
    const cause = new TypeError("inner");
    const error = new Error("outer", { cause }) as Error & { code: string };
    error.code = "E_OUTER";

    expect(normalizeSerializableError(error)).toMatchObject({
      cause: {
        message: "inner",
        name: "TypeError",
      },
      code: "E_OUTER",
      message: "outer",
      name: "Error",
    });
  });

  it("rebuilds normalized objects into Errors", () => {
    const rebuilt = rebuildSerializableError({
      cause: {
        message: "inner",
        name: "TypeError",
      },
      code: "E_OUTER",
      message: "outer",
      name: "EveError",
    });

    expect(rebuilt).toBeInstanceOf(Error);
    expect(rebuilt).toMatchObject({
      code: "E_OUTER",
      message: "outer",
      name: "EveError",
    });
    expect(rebuilt.cause).toMatchObject({
      message: "inner",
      name: "TypeError",
    });
  });
});
