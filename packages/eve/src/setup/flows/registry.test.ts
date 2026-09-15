import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import { runRegistryFlow, type RegistryFlowDeps } from "./registry.js";
function deps(): RegistryFlowDeps {
  return {
    browseRegistryCatalog: vi.fn(async () => ({
      items: [{ address: "connection/linear", name: "Linear", source: "Vercel" }],
      total: 1,
      errors: [],
    })),
    installRegistryItem: vi.fn(async () => ({ output: [] })),
    detectDeployment: vi.fn(async () => ({ state: "unlinked" }) as const),
    runDeployFlow: vi.fn(async () => ({ kind: "deployed" }) as const),
  };
}
describe("runRegistryFlow", () => {
  it("searches one catalog and installs the chosen item without a review", async () => {
    const flow = deps();
    const fake = createFakePrompter({
      single: (options) => {
        expect(options.search).toBe(true);
        return "connection/linear";
      },
    });
    expect(
      (await runRegistryFlow({ appRoot: "/agent", prompter: fake.prompter, deps: flow })).kind,
    ).toBe("done");
    expect(fake.selectMessages).toEqual(["Add to your agent"]);
    expect(flow.installRegistryItem).toHaveBeenCalledOnce();
    expect(flow.installRegistryItem).toHaveBeenCalledWith(
      "/agent",
      "connection/linear",
      expect.any(Object),
    );
  });
  it("installs an explicit address without another confirmation", async () => {
    const flow = deps();
    const fake = createFakePrompter();
    await runRegistryFlow({
      appRoot: "/agent",
      initialAddress: "connection/linear",
      prompter: fake.prompter,
      deps: flow,
    });
    expect(fake.selectMessages).toEqual([]);
    expect(flow.browseRegistryCatalog).not.toHaveBeenCalled();
    expect(flow.installRegistryItem).toHaveBeenCalledOnce();
  });
  it("cancels before installing anything", async () => {
    const flow = deps();
    const fake = createFakePrompter({
      single: () => {
        throw new WizardCancelledError();
      },
    });
    expect(
      await runRegistryFlow({ appRoot: "/agent", prompter: fake.prompter, deps: flow }),
    ).toEqual({ kind: "cancelled" });
    expect(flow.installRegistryItem).not.toHaveBeenCalled();
  });
});
