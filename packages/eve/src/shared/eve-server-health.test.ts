import { afterEach, describe, expect, it, vi } from "vitest";

import { isEveServerHealthy } from "./eve-server-health.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isEveServerHealthy", () => {
  it("refuses health redirects", async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.redirect).toBe("error");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(isEveServerHealthy("http://127.0.0.1:2000")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:2000/eve/v1/health",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
  });
});
