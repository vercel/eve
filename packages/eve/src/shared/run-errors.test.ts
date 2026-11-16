import { describe, expect, it } from "vitest";

import { FatalError } from "#compiled/@workflow/core/index.js";
import {
  EntityConflictError,
  HookNotFoundError as WorkflowHookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";
import {
  HookNotFoundError,
  isHookNotFound,
  isRunExpired,
  isRunInactive,
  isRunMissing,
  isRunNotFound,
  isRunTargetGone,
  NonRetryableError,
} from "#shared/run-errors.js";

// eve's run errors and Workflow's must recognize each other, so either host's code reads the
// other's errors and a report names them as before.

describe("run errors", () => {
  it("are Workflow's to Workflow's own checks", () => {
    const fatal = new NonRetryableError("no retry");
    expect(FatalError.is(fatal)).toBe(true);
    expect(fatal.name).toBe("FatalError");
    const missing = new HookNotFoundError("hook-token");
    expect(WorkflowHookNotFoundError.is(missing)).toBe(true);
    expect({ message: missing.message, token: missing.token }).toEqual({
      message: new WorkflowHookNotFoundError("hook-token").message,
      token: "hook-token",
    });
  });

  it("read Workflow's errors, through their causes where the question needs it", () => {
    const notFound = new WorkflowRunNotFoundError("wrun_1");
    const expired = new RunExpiredError("gone", "wrun_1", "completed", new Date(0));
    const conflict = new EntityConflictError("held");
    expect(isHookNotFound(new WorkflowHookNotFoundError("t"))).toBe(true);
    expect(isRunNotFound(new Error("wrapped", { cause: notFound }))).toBe(true);
    expect(isRunExpired(expired)).toBe(true);
    expect(isRunMissing(expired)).toBe(true);
    expect(isRunMissing(conflict)).toBe(false);
    expect(isRunInactive(conflict)).toBe(true);
    expect(isRunTargetGone(new Error("wrapped", { cause: new HookNotFoundError("t") }))).toBe(true);
    expect(isRunTargetGone(new Error("other"))).toBe(false);
  });

  it("read a copy that crossed a serializer by its name", () => {
    expect(isHookNotFound({ name: "HookNotFoundError", message: "Hook not found" })).toBe(true);
    expect(isHookNotFound({ name: "HookNotFoundError" })).toBe(false);
  });
});
