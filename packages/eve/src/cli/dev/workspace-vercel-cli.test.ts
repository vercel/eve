import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import {
  ensureWorkspaceVercelCli,
  MINIMUM_WORKSPACE_DEV_VERCEL_VERSION,
} from "./workspace-vercel-cli.js";

const WORKSPACE_ROOT = "/repo";

function detectVersions(...versions: string[]) {
  let index = 0;
  return vi.fn(async () => versions[Math.min(index++, versions.length - 1)]);
}

describe("ensureWorkspaceVercelCli", () => {
  it("continues without prompting when the installed CLI is supported", async () => {
    const detectVercelCliVersion = detectVersions(MINIMUM_WORKSPACE_DEV_VERCEL_VERSION);
    const createPrompter = vi.fn();

    await ensureWorkspaceVercelCli({
      workspaceRoot: WORKSPACE_ROOT,
      deps: { createPrompter, detectVercelCliVersion, hasInteractiveTerminal: () => true },
    });

    expect(detectVercelCliVersion).toHaveBeenCalledWith({ projectRoot: WORKSPACE_ROOT });
    expect(createPrompter).not.toHaveBeenCalled();
  });

  it("gives a recovery command instead of prompting outside a TTY", async () => {
    await expect(
      ensureWorkspaceVercelCli({
        workspaceRoot: WORKSPACE_ROOT,
        deps: {
          detectVercelCliVersion: detectVersions("59.15.0"),
          hasInteractiveTerminal: () => false,
        },
      }),
    ).rejects.toThrow(
      "Vercel CLI 59.15.0 is too old. Workspace development requires 59.16.0 or newer. Run `vercel upgrade`, then retry `eve dev`.",
    );
  });

  it("upgrades interactively, verifies the result, and continues", async () => {
    const fake = createFakePrompter();
    const offerVercelCliUpgrade = vi.fn(async () => ({ kind: "installed" as const }));

    await ensureWorkspaceVercelCli({
      workspaceRoot: WORKSPACE_ROOT,
      deps: {
        createPrompter: () => fake.prompter,
        detectVercelCliVersion: detectVersions("59.15.0", "59.16.0"),
        hasInteractiveTerminal: () => true,
        offerVercelCliUpgrade,
      },
    });

    expect(offerVercelCliUpgrade).toHaveBeenCalledWith({
      appRoot: WORKSPACE_ROOT,
      message: "Vercel CLI 59.15.0 is too old. Upgrade it now?",
      prompter: fake.prompter,
      upgradeLabel: "Upgrade Vercel CLI and continue",
    });
    expect(fake.prompter.log.success).toHaveBeenCalledWith("Upgraded Vercel CLI to 59.16.0.");
  });

  it("stops when the active executable remains too old after upgrading", async () => {
    const fake = createFakePrompter();

    await expect(
      ensureWorkspaceVercelCli({
        workspaceRoot: WORKSPACE_ROOT,
        deps: {
          createPrompter: () => fake.prompter,
          detectVercelCliVersion: detectVersions("59.15.0", "59.15.0"),
          hasInteractiveTerminal: () => true,
          offerVercelCliUpgrade: vi.fn(async () => ({ kind: "installed" as const })),
        },
      }),
    ).rejects.toThrow(
      "Vercel CLI 59.15.0 is too old. Workspace development requires 59.16.0 or newer.",
    );
    expect(fake.prompter.log.success).not.toHaveBeenCalled();
  });

  it("stops when the user declines the upgrade", async () => {
    const fake = createFakePrompter();

    await expect(
      ensureWorkspaceVercelCli({
        workspaceRoot: WORKSPACE_ROOT,
        deps: {
          createPrompter: () => fake.prompter,
          detectVercelCliVersion: detectVersions("59.15.0"),
          hasInteractiveTerminal: () => true,
          offerVercelCliUpgrade: vi.fn(async () => ({ kind: "declined" as const })),
        },
      }),
    ).rejects.toThrow("Run `vercel upgrade`, then retry `eve dev`.");
  });

  it("reports an actionable upgrade failure", async () => {
    const fake = createFakePrompter();

    await expect(
      ensureWorkspaceVercelCli({
        workspaceRoot: WORKSPACE_ROOT,
        deps: {
          createPrompter: () => fake.prompter,
          detectVercelCliVersion: detectVersions("59.15.0"),
          hasInteractiveTerminal: () => true,
          offerVercelCliUpgrade: vi.fn(async () => ({
            kind: "failed" as const,
            reason: "package manager failed",
          })),
        },
      }),
    ).rejects.toThrow(
      "The upgrade failed: package manager failed. Run `vercel upgrade`, then retry `eve dev`.",
    );
  });
});
