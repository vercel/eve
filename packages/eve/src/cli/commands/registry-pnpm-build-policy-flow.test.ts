import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { prepareDeclaredPnpmBuildPolicy } from "./registry-pnpm-build-policy-flow.js";

function createLogger() {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    errors,
    logs,
    error: (message: string) => errors.push(message),
    log: (message: string) => logs.push(message),
  };
}

const policy = {
  packages: ["node-liblzma", "@mongodb-js/zstd"],
  optional: true as const,
  recommendedAction: "ignore-optional" as const,
  reason: "Optional accelerators are not required.",
};

const pnpm = vi.fn(async () => ({ kind: "pnpm" as const, source: "lockfile" as const }));

describe("registry pnpm build policy flow", () => {
  it("applies the interactive policy selection", async () => {
    const logger = createLogger();
    const select = vi.fn(() => "ignore-optional");
    const { prompter } = createFakePrompter({ single: select });
    const context = {
      filePath: "/project/pnpm-workspace.yaml",
      packages: policy.packages,
      satisfied: false,
    };
    const applyPnpmBuildPolicy = vi.fn(async () => {});

    await expect(
      prepareDeclaredPnpmBuildPolicy(
        {
          logger,
          appRoot: "/project",
          item: "experimental/tool",
          policies: [policy],
          options: { prompter },
        },
        {
          detectPackageManager: pnpm,
          inspectPnpmBuildPolicy: vi.fn(async () => context),
          applyPnpmBuildPolicy,
        },
      ),
    ).resolves.toBe(true);
    expect(applyPnpmBuildPolicy).toHaveBeenCalledWith(context, "ignore-optional");
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        hintLayout: "stacked",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "ignore-optional", hint: expect.any(String) }),
          expect.objectContaining({ value: "allow-builds", hint: expect.any(String) }),
          expect.objectContaining({ value: "abort", hint: "Do not add this registry item." }),
        ]),
      }),
    );
  });

  it("cancels before changing policy when abort is selected", async () => {
    const logger = createLogger();
    const { prompter } = createFakePrompter({ single: () => "abort" });
    const applyPnpmBuildPolicy = vi.fn(async () => {});

    await expect(
      prepareDeclaredPnpmBuildPolicy(
        {
          logger,
          appRoot: "/project",
          item: "experimental/tool",
          policies: [policy],
          options: { prompter },
        },
        {
          detectPackageManager: pnpm,
          inspectPnpmBuildPolicy: vi.fn(async () => ({
            filePath: "/project/pnpm-workspace.yaml",
            packages: policy.packages,
            satisfied: false,
          })),
          applyPnpmBuildPolicy,
        },
      ),
    ).resolves.toBe(false);
    expect(applyPnpmBuildPolicy).not.toHaveBeenCalled();
  });

  it("blocks a headless install until a policy is selected", async () => {
    const logger = createLogger();

    await expect(
      prepareDeclaredPnpmBuildPolicy(
        {
          logger,
          appRoot: "/project",
          item: "experimental/tool",
          policies: [policy],
          options: { nonInteractive: true },
        },
        {
          detectPackageManager: pnpm,
          inspectPnpmBuildPolicy: vi.fn(async () => ({
            filePath: "/project/pnpm-workspace.yaml",
            packages: policy.packages,
            satisfied: false,
          })),
        },
      ),
    ).resolves.toBe(false);

    expect(JSON.parse(logger.errors[0]!)).toMatchObject({
      type: "blocked",
      item: "experimental/tool",
      installed: false,
      status: "input_required",
      question: {
        key: "install.pnpm.buildScripts",
        recommended: "ignore-optional",
      },
      next: {
        command: "eve",
        args: [
          "add",
          "experimental/tool",
          "--non-interactive",
          "--answer",
          "install.pnpm.buildScripts=<JSON value>",
        ],
      },
    });
  });
});
