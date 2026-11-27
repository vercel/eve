import { describe, expect, it, vi } from "vitest";
import type { SessionAuthContext } from "#channel/types.js";
import { WorkflowWorldError } from "#compiled/@workflow/errors/index.js";
import { INVOCATION_OWNER_ATTRIBUTE, invocationOwnerKey } from "./metadata.js";
import { readOwnedInvocationRun, sessionOwnedBy } from "./owned-run.js";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: async () => ({ runs: { get: mocks.get } }),
}));

describe("readOwnedInvocationRun", () => {
  it("treats an invocation id the world rejects as malformed as not found", async () => {
    mocks.get.mockRejectedValueOnce(
      new WorkflowWorldError("GET /v2/runs/timing-test-0000 -> HTTP 400: Bad Request", {
        status: 400,
        code: "validation-error",
      }),
    );

    await expect(readOwnedInvocationRun("timing-test-0000", null)).resolves.toBeUndefined();
  });

  it("treats an unsafe entity id error from the local world as not found", async () => {
    const error = new Error('Invalid runId "../escape"');
    error.name = "UnsafeEntityIdError";
    mocks.get.mockRejectedValueOnce(error);

    await expect(readOwnedInvocationRun("../escape", null)).resolves.toBeUndefined();
  });

  it("rethrows non-400 world errors", async () => {
    const error = new WorkflowWorldError(
      "GET /v2/runs/wrun_123 -> HTTP 500: Internal Server Error",
      {
        status: 500,
      },
    );
    mocks.get.mockRejectedValueOnce(error);

    await expect(readOwnedInvocationRun("wrun_123", null)).rejects.toBe(error);
  });
});

describe("sessionOwnedBy", () => {
  const alice: SessionAuthContext = {
    attributes: {},
    authenticator: "test",
    principalId: "alice",
    principalType: "user",
  };
  const bob = { ...alice, principalId: "bob" };
  const ownedByAlice = { attributes: { [INVOCATION_OWNER_ATTRIBUTE]: invocationOwnerKey(alice) } };

  it("is true only for the principal recorded as the owner", async () => {
    mocks.get.mockResolvedValue(ownedByAlice);

    await expect(sessionOwnedBy("wrun_1", alice)).resolves.toBe(true);
    await expect(sessionOwnedBy("wrun_1", bob)).resolves.toBe(false);
    await expect(sessionOwnedBy("wrun_1", null)).resolves.toBe(false);
    expect(mocks.get).toHaveBeenCalledWith("wrun_1", { resolveData: "none" });
  });

  it("matches an anonymous owner only for an anonymous caller", async () => {
    mocks.get.mockResolvedValue({
      attributes: { [INVOCATION_OWNER_ATTRIBUTE]: invocationOwnerKey(null) },
    });

    await expect(sessionOwnedBy("wrun_1", null)).resolves.toBe(true);
    await expect(sessionOwnedBy("wrun_1", alice)).resolves.toBe(false);
  });

  it("fails closed for a session with no recorded owner", async () => {
    mocks.get.mockResolvedValue({ attributes: {} });

    await expect(sessionOwnedBy("wrun_1", alice)).resolves.toBe(false);
    await expect(sessionOwnedBy("wrun_1", null)).resolves.toBe(false);
  });

  it("is false for a missing or malformed session id", async () => {
    mocks.get.mockRejectedValueOnce(
      new WorkflowWorldError("GET /v2/runs/x -> HTTP 400: Bad Request", { status: 400 }),
    );

    await expect(sessionOwnedBy("x", alice)).resolves.toBe(false);
  });

  it("rethrows non-400 world errors", async () => {
    const error = new WorkflowWorldError("GET /v2/runs/x -> HTTP 500: Boom", { status: 500 });
    mocks.get.mockRejectedValueOnce(error);

    await expect(sessionOwnedBy("x", alice)).rejects.toBe(error);
  });
});
