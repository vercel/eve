import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import {
  ensureWorkspaceVercelCli,
  MINIMUM_WORKSPACE_DEV_VERCEL_VERSION,
} from "./workspace-vercel-cli.js";

const WORKSPACE_ROOT = "/repo";

function captureVersions(...versions: string[]) {
  let index = 0;
  return vi.fn(async () => ({
    ok: true as const,
    stdout: `Vercel CLI ${versions[Math.min(index++, versions.length - 1)]}`,
  }));
}

describe("ensureWorkspaceVercelCli", () => {
  it("continues without prompting when the installed CLI is supported", async () => {
    const captureVercel = captureVersions(MINIMUM_WORKSPACE_DEV_VERCEL_VERSION);
    const createPrompter = vi.fn();

    await ensureWorkspaceVercelCli({
      workspaceRoot: WORKSPACE_ROOT,
      deps: { captureVercel, createPrompter, hasInteractiveTerminal: () => true },
    });

    expect(captureVercel).toHaveBeenCalledWith(["--version"], {
      cwd: WORKSPACE_ROOT,
      nonInteractive: true,
    });
    expect(createPrompter).not.toHaveBeenCalled();
  });

  it("gives a recovery command instead of prompting outside a TTY", async () => {
    await expect(
      ensureWorkspaceVercelCli({
        workspaceRoot: WORKSPACE_ROOT,
        deps: {
          captureVercel: captureVersions("59.15.0"),
          hasInteractiveTerminal: () => false,
        },
      }),
    ).rejects.toThrow(
      "Vercel CLI 59.15.0 is too old. Workspace development requires 59.16.0 or newer. Run `vercel upgrade`, then retry `eve dev`.",
    );
  });

  it("upgrades interactively, verifies the result, and continues", async () => {
    const fake = createFakePrompter({ single: () => "upgrade" });
    const runInstallVercelCliFlow = vi.fn(async () => ({ kind: "installed" as const }));

    await ensureWorkspaceVercelCli({
      workspaceRoot: WORKSPACE_ROOT,
      deps: {
        captureVercel: captureVersions("59.15.0", "59.16.0"),
        createPrompter: () => fake.prompter,
        hasInteractiveTerminal: () => true,
        runInstallVercelCliFlow,
      },
    });

    expect(fake.selectMessages).toEqual(["Vercel CLI 59.15.0 is too old. Upgrade it now?"]);
    expect(runInstallVercelCliFlow).toHaveBeenCalledWith({
      appRoot: WORKSPACE_ROOT,
      prompter: fake.prompter,
      upgrade: true,
    });
    expect(fake.prompter.log.success).toHaveBeenCalledWith("Upgraded Vercel CLI to 59.16.0.");
  });

  it("stops when the active executable remains too old after upgrading", async () => {
    const fake = createFakePrompter({ single: () => "upgrade" });

    await expect(
      ensureWorkspaceVercelCli({
        workspaceRoot: WORKSPACE_ROOT,
        deps: {
          captureVercel: captureVersions("59.15.0", "59.15.0"),
          createPrompter: () => fake.prompter,
          hasInteractiveTerminal: () => true,
          runInstallVercelCliFlow: vi.fn(async () => ({ kind: "installed" as const })),
        },
      }),
    ).rejects.toThrow(
      "Vercel CLI 59.15.0 is too old. Workspace development requires 59.16.0 or newer.",
    );
    expect(fake.prompter.log.success).not.toHaveBeenCalled();
  });

  it("stops when the user declines the upgrade", async () => {
    const fake = createFakePrompter({ single: () => "cancel" });
    const runInstallVercelCliFlow = vi.fn();

    await expect(
      ensureWorkspaceVercelCli({
        workspaceRoot: WORKSPACE_ROOT,
        deps: {
          captureVercel: captureVersions("59.15.0"),
          createPrompter: () => fake.prompter,
          hasInteractiveTerminal: () => true,
          runInstallVercelCliFlow,
        },
      }),
    ).rejects.toThrow("Run `vercel upgrade`, then retry `eve dev`.");
    expect(runInstallVercelCliFlow).not.toHaveBeenCalled();
  });

  it("reports an actionable upgrade failure", async () => {
    const fake = createFakePrompter({ single: () => "upgrade" });

    await expect(
      ensureWorkspaceVercelCli({
        workspaceRoot: WORKSPACE_ROOT,
        deps: {
          captureVercel: captureVersions("59.15.0"),
          createPrompter: () => fake.prompter,
          hasInteractiveTerminal: () => true,
          runInstallVercelCliFlow: vi.fn(async () => ({
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
