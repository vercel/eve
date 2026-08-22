import { describe, expect, it, vi } from "vitest";

import {
  clearVercelEgressDemandMarkers,
  getVercelEgressDemandMarkerPath,
  readVercelEgressDemandedRuleIds,
} from "#execution/sandbox/bindings/vercel-egress-demand.js";

describe("Vercel egress demand markers", () => {
  it("reads and clears only known demanded rules", async () => {
    const readFile = vi.fn(async ({ path }: { path: string }) =>
      path.endsWith("r0-1") ? new ReadableStream() : null,
    );
    const rm = vi.fn(async () => {});
    const sandbox = { fs: { rm }, readFile } as never;

    await expect(readVercelEgressDemandedRuleIds(sandbox, ["r0-0", "r0-1"])).resolves.toEqual([
      "r0-1",
    ]);
    await clearVercelEgressDemandMarkers(sandbox, ["r0-1"]);
    expect(rm).toHaveBeenCalledWith("/tmp/eve-egress-demand/r0-1", { force: true });
  });

  it("rejects marker path traversal", () => {
    expect(() => getVercelEgressDemandMarkerPath("../../token")).toThrow(/Invalid/);
  });
});
