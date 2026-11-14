import { describe, expect, it } from "vitest";

import { errorInfoOf } from "#harness/facts.js";

describe("errorInfoOf", () => {
  it("carries the thrown error's class name, its support id and its remedy", () => {
    expect(
      errorInfoOf({
        code: "MODEL_CALL_FAILED",
        details: { errorId: "err_1", hint: " Sign in again. ", name: "TokenRejectedError" },
        message: "The provider rejected the token.",
      }),
    ).toEqual({
      code: "MODEL_CALL_FAILED",
      hint: "Sign in again.",
      id: "err_1",
      message: "The provider rejected the token.",
      name: "TokenRejectedError",
    });
  });

  it("leaves out a name that tells a reader nothing", () => {
    for (const name of ["Error", "", 42]) {
      expect(errorInfoOf({ code: "BOOM", details: { name }, message: "It broke." })).toEqual({
        code: "BOOM",
        message: "It broke.",
      });
    }
  });
});
