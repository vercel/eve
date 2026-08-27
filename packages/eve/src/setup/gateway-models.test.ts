import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ captureVercel: vi.fn() }));

vi.mock("#setup/primitives/index.js", () => ({
  captureVercel: mocks.captureVercel,
}));

import { fetchGatewayModelIds } from "#setup/gateway-models.js";

describe("fetchGatewayModelIds", () => {
  it("identifies eve on the Vercel-authenticated catalog request", async () => {
    mocks.captureVercel.mockResolvedValueOnce({ ok: true, stdout: '{"data":[]}' });

    await fetchGatewayModelIds("/tmp/app");

    expect(mocks.captureVercel).toHaveBeenCalledWith(
      expect.arrayContaining(["--header", expect.stringMatching(/^User-Agent: eve\/.+/)]),
      { cwd: "/tmp/app" },
    );
  });
});
