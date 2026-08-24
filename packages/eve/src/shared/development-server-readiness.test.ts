import { afterEach, describe, expect, it, vi } from "vitest";

import { readDevelopmentServerReadiness } from "#shared/development-server-readiness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readDevelopmentServerReadiness", () => {
  it("reads identity from the internal development control route", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ revision: "rev-1", serverId: "server-1" }));

    await expect(
      readDevelopmentServerReadiness("http://127.0.0.1:3000", {
        expectedServerId: "server-1",
      }),
    ).resolves.toEqual({ serverId: "server-1" });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3000/eve/v1/dev/runtime-artifacts", {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects a healthy response from a different server owner", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ revision: "rev-1", serverId: "server-other" }),
    );

    await expect(
      readDevelopmentServerReadiness("http://127.0.0.1:3000", {
        expectedServerId: "server-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects successful responses without a recorded identity", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ revision: "rev-1" }));

    await expect(readDevelopmentServerReadiness("http://127.0.0.1:3000")).resolves.toBeUndefined();
  });
});
