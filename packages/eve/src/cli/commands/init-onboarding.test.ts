import { describe, expect, it, vi } from "vitest";

import type { RegistryCatalogItem } from "#cli/commands/registry.js";
import { createFakeSetupFlowRenderer } from "#cli/dev/tui/test/fake-setup-flow-renderer.js";
import { packageInstallResult } from "#internal/testing/package-process.js";

import { runInitOnboarding, type InitOnboardingDeps } from "./init-onboarding.js";

const APP_ROOT = "/tmp/my-agent";
const WEB: RegistryCatalogItem = {
  address: "channel/web",
  name: "web",
  source: "eve",
};

function createDeps() {
  const flow = createFakeSetupFlowRenderer();
  const renderer = {
    renderCommandResult: vi.fn(),
    setupFlow: flow,
    shutdown: vi.fn(),
  };
  const deps: InitOnboardingDeps = {
    createRenderer: () => renderer,
    planProviderChoice: vi.fn<InitOnboardingDeps["planProviderChoice"]>(async () => ({
      kind: "ai-gateway-project",
    })),
    planRegistryFlow: vi.fn<InitOnboardingDeps["planRegistryFlow"]>(async () => ({
      kind: "done",
      items: [WEB],
    })),
    runTuiSetupCommand: vi.fn<InitOnboardingDeps["runTuiSetupCommand"]>(async () => ({
      message: "done",
      preserveFlowDiagnostics: false,
    })),
  };
  return { deps, flow, renderer };
}

describe("runInitOnboarding", () => {
  it("collects choices while install runs, then applies them after install and Git", async () => {
    const install = Promise.withResolvers<ReturnType<typeof packageInstallResult>>();
    const { deps, renderer } = createDeps();
    const order: string[] = [];
    vi.mocked(deps.planProviderChoice).mockImplementation(async () => {
      order.push("provider-planned");
      return { kind: "ai-gateway-project" };
    });
    vi.mocked(deps.planRegistryFlow).mockImplementation(async (input) => {
      order.push("registry-planned");
      expect(order).toEqual(["provider-planned", "registry-planned"]);
      install.resolve(packageInstallResult());
      await input.beforeReview?.();
      order.push("reviewed");
      return { kind: "done", items: [WEB] };
    });
    vi.mocked(deps.runTuiSetupCommand).mockImplementation(async (input) => {
      order.push(input.command);
      return { message: `${input.command} done`, preserveFlowDiagnostics: false };
    });

    await expect(
      runInitOnboarding({
        appRoot: APP_ROOT,
        install: install.promise,
        afterInstall: async () => {
          order.push("git");
        },
        deps,
      }),
    ).resolves.toEqual({ install: packageInstallResult(), onboarded: true });

    expect(order).toEqual([
      "provider-planned",
      "registry-planned",
      "git",
      "reviewed",
      "model",
      "add",
    ]);
    expect(deps.runTuiSetupCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: "model",
        initialProviderChoice: { kind: "ai-gateway-project" },
      }),
    );
    expect(deps.runTuiSetupCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: "add", initialRegistryItems: [WEB] }),
    );
    expect(renderer.shutdown).toHaveBeenCalledWith({ partingLine: false });
  });

  it("does not mutate the project when the base install fails", async () => {
    const failedInstall = packageInstallResult(1);
    const { deps } = createDeps();
    const afterInstall = vi.fn(async () => {});
    vi.mocked(deps.planRegistryFlow).mockImplementation(async (input) => {
      await input.beforeReview?.();
      throw new Error("review should not open");
    });

    await expect(
      runInitOnboarding({
        appRoot: APP_ROOT,
        install: Promise.resolve(failedInstall),
        afterInstall,
        deps,
      }),
    ).resolves.toEqual({ install: failedInstall, onboarded: false });

    expect(afterInstall).not.toHaveBeenCalled();
    expect(deps.runTuiSetupCommand).not.toHaveBeenCalled();
  });
});
