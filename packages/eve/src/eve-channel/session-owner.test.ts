import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import {
  HTTP_SESSION_OWNER_ATTRIBUTE,
  httpSessionOwnerKey,
  isHttpSessionOwner,
} from "#eve-channel/session-owner.js";

const readRun = vi.hoisted(() => vi.fn());
vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: async () => ({ runs: { get: readRun } }),
}));
const alice = {
  attributes: {},
  authenticator: "app",
  issuer: "workspace-a",
  principalId: "alice",
  principalType: "user",
};

beforeEach(() => {
  readRun.mockReset();
});

describe("HTTP session ownership", () => {
  it("permits only the recorded creator, including the issuer boundary", async () => {
    readRun.mockResolvedValue({
      attributes: { [HTTP_SESSION_OWNER_ATTRIBUTE]: httpSessionOwnerKey(alice) },
    });
    await expect(isHttpSessionOwner("alice-session", alice)).resolves.toBe(true);
    await expect(
      isHttpSessionOwner("alice-session", { ...alice, principalId: "bob" }),
    ).resolves.toBe(false);
    await expect(
      isHttpSessionOwner("alice-session", { ...alice, issuer: "workspace-b" }),
    ).resolves.toBe(false);
    expect(readRun).toHaveBeenLastCalledWith("alice-session", { resolveData: "none" });
  });

  it("keeps an explicit issuer distinct from an authenticator with the same name", async () => {
    readRun.mockResolvedValue({
      attributes: {
        [HTTP_SESSION_OWNER_ATTRIBUTE]: httpSessionOwnerKey({ ...alice, issuer: undefined }),
      },
    });
    await expect(isHttpSessionOwner("alice-session", { ...alice, issuer: "app" })).resolves.toBe(
      false,
    );
  });

  it("denies missing owner metadata and missing runs", async () => {
    readRun.mockResolvedValueOnce({ attributes: {} });
    await expect(isHttpSessionOwner("old-session", alice)).resolves.toBe(false);
    readRun.mockRejectedValueOnce(new WorkflowRunNotFoundError("missing-session"));
    await expect(isHttpSessionOwner("missing-session", alice)).resolves.toBe(false);
  });

  it("does not turn a backing-store failure into an access grant", async () => {
    const error = new Error("Backing store unavailable");
    readRun.mockRejectedValue(error);
    await expect(isHttpSessionOwner("alice-session", alice)).rejects.toBe(error);
  });

  it("does not issue a user owner key for shared transport principals", async () => {
    const service = { ...alice, principalType: "service" };
    expect(httpSessionOwnerKey(service)).toBeUndefined();
    expect(httpSessionOwnerKey(null)).toBeUndefined();
    await expect(isHttpSessionOwner("service-session", service)).resolves.toBe(false);
    expect(readRun).not.toHaveBeenCalled();
  });
});
