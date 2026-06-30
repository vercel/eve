import { describe, expect, it, vi } from "vitest";

import { createDefaultSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import { preflight, type PreflightDeps } from "./preflight.js";

const silentSink: OutputSink = { write: () => {} };

function depsWithCatalog(ids: Set<string> | null): PreflightDeps {
  return { fetchGatewayModelIds: vi.fn(async () => ids) };
}

function stateWithModel(
  modelId: string,
  modelWiring: SetupState["modelWiring"] = "gateway",
): SetupState {
  return { ...createDefaultSetupState(), modelId, modelWiring };
}

describe("preflight box", () => {
  it("rejects a headless model that is not in the AI Gateway catalog", async () => {
    const box = preflight({
      cwd: "/x",
      headless: true,
      deps: depsWithCatalog(new Set(["anthropic/claude-sonnet-5"])),
    });

    await expect(runHeadless([box], stateWithModel("anthropic/bogus"), silentSink)).rejects.toThrow(
      /not in the AI Gateway catalog/,
    );
  });

  it("accepts a headless model present in the catalog", async () => {
    const box = preflight({
      cwd: "/x",
      headless: true,
      deps: depsWithCatalog(new Set(["anthropic/claude-sonnet-5"])),
    });

    await expect(
      runHeadless([box], stateWithModel("anthropic/claude-sonnet-5"), silentSink),
    ).resolves.toMatchObject({ modelId: "anthropic/claude-sonnet-5" });
  });

  it("does not block when the catalog is unreachable", async () => {
    const deps = depsWithCatalog(null);
    const box = preflight({ cwd: "/x", headless: true, deps });

    await expect(
      runHeadless([box], stateWithModel("anything/at-all"), silentSink),
    ).resolves.toBeDefined();
    expect(deps.fetchGatewayModelIds).toHaveBeenCalledWith("/x");
  });

  it("skips the gateway model fetch in interactive runs", async () => {
    const deps = depsWithCatalog(new Set(["anthropic/claude-sonnet-5"]));
    const box = preflight({ cwd: "/x", deps });

    const result = await runInteractive([box], stateWithModel("anthropic/bogus"), silentSink);

    expect(result.kind).toBe("done");
    expect(deps.fetchGatewayModelIds).not.toHaveBeenCalled();
  });

  it("validates the model for self-managed provider wiring too", async () => {
    // The byok scaffold bakes a gateway-format model id just like the gateway
    // wiring does, so a headless --model is checked on every wiring.
    const deps = depsWithCatalog(new Set(["anthropic/claude-sonnet-5"]));
    const box = preflight({ cwd: "/x", headless: true, deps });

    await expect(
      runHeadless([box], stateWithModel("anthropic/bogus", "self"), silentSink),
    ).rejects.toThrow(/not in the AI Gateway catalog/);
  });

  it("validates the model when Vercel is skipped but AI Gateway wiring is still used", async () => {
    // skip-vercel + a pasted gateway key resolves to gateway wiring, which
    // still routes the model through the catalog.
    const box = preflight({
      cwd: "/x",
      headless: true,
      deps: depsWithCatalog(new Set(["anthropic/claude-sonnet-5"])),
    });
    const state: SetupState = {
      ...stateWithModel("anthropic/bogus", "gateway"),
      vercelProject: { kind: "none" },
      aiGateway: { kind: "byok", apiGatewayKey: "vck_test" },
    };

    await expect(runHeadless([box], state, silentSink)).rejects.toThrow(
      /not in the AI Gateway catalog/,
    );
  });
});
