import { describe, expect, it, vi } from "vitest";

import {
  clearVercelEgressDemandMarkers,
  getVercelEgressDemandMarkerPath,
  mintVercelEgressDemandToken,
  readVercelEgressDemandedRuleIds,
} from "#execution/sandbox/bindings/vercel-egress-demand.js";

const TOKEN = mintVercelEgressDemandToken();

function markerSandbox(markers: Record<string, string>) {
  const rm = vi.fn(async () => {});
  return {
    fs: { rm },
    readFile: vi.fn(async ({ path }: { path: string }) => {
      const content = markers[path.split("/").at(-1)!];
      return content === undefined ? null : new Response(content).body;
    }),
    rm,
  };
}

describe("Vercel egress demand markers", () => {
  it("honors only markers whose content matches the demand token", async () => {
    const sandbox = markerSandbox({ "r0-0": "forged-by-sandbox-code", "r0-1": TOKEN });

    await expect(
      readVercelEgressDemandedRuleIds(sandbox as never, ["r0-0", "r0-1", "r0-2"], TOKEN),
    ).resolves.toEqual(["r0-1"]);
  });

  it("honors no markers without an expected demand token", async () => {
    const sandbox = markerSandbox({ "r0-0": TOKEN });

    await expect(
      readVercelEgressDemandedRuleIds(sandbox as never, ["r0-0"], undefined),
    ).resolves.toEqual([]);
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it("clears markers by rule id", async () => {
    const sandbox = markerSandbox({});

    await clearVercelEgressDemandMarkers(sandbox as never, ["r0-1"]);
    expect(sandbox.rm).toHaveBeenCalledWith("/tmp/eve-egress-demand/r0-1", { force: true });
  });

  it("mints URL-safe unguessable tokens", () => {
    expect(mintVercelEgressDemandToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintVercelEgressDemandToken()).not.toBe(TOKEN);
  });

  it("rejects marker path traversal", () => {
    expect(() => getVercelEgressDemandMarkerPath("../../token")).toThrow(/Invalid/);
  });
});
