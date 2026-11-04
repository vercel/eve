import { describe, expect, it } from "vitest";

import {
  exhaustedStepError,
  normalizeSerializableError,
  rebuildSerializableError,
} from "#execution/workflow-errors.js";

describe("workflow-errors", () => {
  it("preserves an authored fatal error rather than exposing its cause as the step failure", () => {
    const error = {
      name: "FatalError",
      message: "Invalid configuration",
      cause: new Error("inner"),
    };
    expect(exhaustedStepError(error)).toBe(error);
  });

  it.each([
    'Step "turnStep" failed after 3 retries: Disk full',
    'Step "turnStep" exceeded max retries (3 retries)',
  ])("recovers the original failure from the workflow exhaustion wrapper: %s", (message) => {
    const cause = { name: "Error", message: "Disk full", code: "ENOSPC" };
    expect(exhaustedStepError({ name: "FatalError", message, cause })).toBe(cause);
  });

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
