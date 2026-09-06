import { describe, expect, it } from "vitest";

import { isVercelSnapshottingError } from "#execution/sandbox/bindings/vercel-errors.js";

function snapshottingError(overrides?: { status?: number; code?: string }): Error {
  return Object.assign(new Error("Status code 422 is not ok"), {
    json: { error: { code: overrides?.code ?? "sandbox_snapshotting" } },
    response: { status: overrides?.status ?? 422 },
  });
}

describe("isVercelSnapshottingError", () => {
  it("matches a 422 sandbox_snapshotting response", () => {
    expect(isVercelSnapshottingError(snapshottingError())).toBe(true);
  });

  it("matches when the SDK error is wrapped as a cause", () => {
    const wrapped = new Error("Failed to look up Vercel sandbox", { cause: snapshottingError() });
    expect(isVercelSnapshottingError(wrapped)).toBe(true);
  });

  it("requires the snapshotting code, not just a 422", () => {
    expect(isVercelSnapshottingError(snapshottingError({ code: "bad_request" }))).toBe(false);
  });

  it("requires a 422, not just the snapshotting code", () => {
    expect(isVercelSnapshottingError(snapshottingError({ status: 500 }))).toBe(false);
  });
});
