import { describe, expect, it, vi } from "vitest";

import {
  clearVercelEgressDemandMarkers,
  getVercelEgressDemandMarkerPath,
  isVercelEgressRuleId,
  mintVercelEgressDemandToken,
  readVercelEgressDemandedRuleIds,
  vercelEgressRuleId,
} from "#execution/sandbox/bindings/vercel-egress-demand.js";

const TOKEN = mintVercelEgressDemandToken();
const RULE_A = vercelEgressRuleId("a.example.com", 0);
const RULE_B = vercelEgressRuleId("b.example.com", 0);
const RULE_C = vercelEgressRuleId("c.example.com", 0);

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
    const sandbox = markerSandbox({ [RULE_A]: "forged-by-sandbox-code", [RULE_B]: TOKEN });

    await expect(
      readVercelEgressDemandedRuleIds(sandbox as never, [RULE_A, RULE_B, RULE_C], TOKEN),
    ).resolves.toEqual([RULE_B]);
  });

  it("honors no markers without an expected demand token", async () => {
    const sandbox = markerSandbox({ [RULE_A]: TOKEN });

    await expect(
      readVercelEgressDemandedRuleIds(sandbox as never, [RULE_A], undefined),
    ).resolves.toEqual([]);
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it("clears markers by rule id", async () => {
    const sandbox = markerSandbox({});

    await clearVercelEgressDemandMarkers(sandbox as never, [RULE_B]);
    expect(sandbox.rm).toHaveBeenCalledWith(`/tmp/eve-egress-demand/${RULE_B}`, { force: true });
  });

  it("mints URL-safe unguessable tokens", () => {
    expect(mintVercelEgressDemandToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintVercelEgressDemandToken()).not.toBe(TOKEN);
  });

  it("derives rule ids from the domain so policy reordering cannot re-attribute them", () => {
    expect(RULE_A).toBe(vercelEgressRuleId("a.example.com", 0));
    expect(RULE_A).not.toBe(RULE_B);
    expect(RULE_A).toMatch(/^r-[0-9a-f]{12}-0$/);
    expect(isVercelEgressRuleId(RULE_A)).toBe(true);
    expect(isVercelEgressRuleId("r0-0")).toBe(false);
  });

  it("rejects marker path traversal", () => {
    expect(() => getVercelEgressDemandMarkerPath("../../token")).toThrow(/Invalid/);
  });
});
