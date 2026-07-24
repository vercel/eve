import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { DetectedPackageManager } from "#setup/package-manager.js";

import { runInstallVercelCliFlow, type InstallVercelCliDeps } from "./install-vercel-cli.js";

const APP_ROOT = "/app/my-agent";

/** Auth-status probe returning the given sequence across successive calls. */
function statusProbe(
  ...results: Array<"authenticated" | "logged-out" | "cli-missing">
): InstallVercelCliDeps["getVercelAuthStatus"] {
  let call = 0;
  return vi.fn(async () => results[Math.min(call++, results.length - 1)] ?? "cli-missing");
}

function detectPnpm(): InstallVercelCliDeps["detectPackageManager"] {
  return vi.fn(async (): Promise<DetectedPackageManager> => ({ kind: "pnpm", source: "lockfile" }));
}

function run(
  deps: Partial<InstallVercelCliDeps>,
  spawnPackageManager?: InstallVercelCliDeps["spawnPackageManager"],
  upgrade = false,
) {
  const { prompter } = createFakePrompter({});
  const merged: Partial<InstallVercelCliDeps> = {
    detectPackageManager: detectPnpm(),
    runVercel: vi.fn(async () => true),
    ...deps,
  };
  if (spawnPackageManager !== undefined) merged.spawnPackageManager = spawnPackageManager;
  return runInstallVercelCliFlow({ appRoot: APP_ROOT, prompter, deps: merged, upgrade });
}

describe("runInstallVercelCliFlow", () => {
  it("short-circuits when the CLI already resolves and never installs", async () => {
    const spawnPackageManager = vi.fn<InstallVercelCliDeps["spawnPackageManager"]>(
      async () => true,
    );
    await expect(
      run({ getVercelAuthStatus: statusProbe("logged-out") }, spawnPackageManager),
    ).resolves.toEqual({ kind: "already" });
    expect(spawnPackageManager).not.toHaveBeenCalled();
  });

  it("installs globally with the project's package manager, then re-probes", async () => {
    const spawnPackageManager = vi.fn<InstallVercelCliDeps["spawnPackageManager"]>(
      async () => true,
    );
    // cli-missing before; logged-out (i.e. CLI now present) after.
    await expect(
      run({ getVercelAuthStatus: statusProbe("cli-missing", "logged-out") }, spawnPackageManager),
    ).resolves.toEqual({ kind: "installed" });
    expect(spawnPackageManager).toHaveBeenCalledWith(
      "pnpm",
      APP_ROOT,
      ["add", "-g", "vercel@latest"],
      expect.objectContaining({}),
    );
  });

  it("uses the active Vercel CLI's native upgrader instead of the project's manager", async () => {
    const detectPackageManager = vi.fn<InstallVercelCliDeps["detectPackageManager"]>(
      async (): Promise<DetectedPackageManager> => ({ kind: "yarn", source: "lockfile" }),
    );
    const runVercel = vi.fn<InstallVercelCliDeps["runVercel"]>(async () => true);
    const spawnPackageManager = vi.fn<InstallVercelCliDeps["spawnPackageManager"]>(
      async () => true,
    );

    await expect(
      run(
        {
          getVercelAuthStatus: statusProbe("authenticated"),
          detectPackageManager,
          runVercel,
        },
        spawnPackageManager,
        true,
      ),
    ).resolves.toEqual({ kind: "installed" });
    expect(runVercel).toHaveBeenCalledWith(
      ["upgrade"],
      expect.objectContaining({
        cwd: APP_ROOT,
        nonInteractive: true,
      }),
    );
    expect(detectPackageManager).not.toHaveBeenCalled();
    expect(spawnPackageManager).not.toHaveBeenCalled();
  });

  it("reports the useful stderr line when the native upgrade exits non-zero", async () => {
    await expect(
      run(
        {
          getVercelAuthStatus: statusProbe("authenticated"),
          runVercel: vi.fn(async (_args, options) => {
            options.onOutput?.({
              stream: "stderr",
              text: "Error: Cannot find module 'path/posix'",
            });
            options.onOutput?.({
              stream: "stderr",
              text: "    at Function.Module._resolveFilename (internal/modules/cjs/loader.js:889:15)",
            });
            options.onOutput?.({
              stream: "stderr",
              text: "vercel upgrade exited with code 1.",
            });
            return false;
          }),
        },
        undefined,
        true,
      ),
    ).resolves.toEqual({
      kind: "failed",
      reason: "Error: Cannot find module 'path/posix'",
    });
  });

  it("reports failed when the install exits non-zero", async () => {
    const spawnPackageManager = vi.fn<InstallVercelCliDeps["spawnPackageManager"]>(
      async () => false,
    );
    await expect(
      run({ getVercelAuthStatus: statusProbe("cli-missing") }, spawnPackageManager),
    ).resolves.toEqual({ kind: "failed" });
  });

  it("reports failed when the install exits clean but the CLI still isn't on PATH", async () => {
    const spawnPackageManager = vi.fn<InstallVercelCliDeps["spawnPackageManager"]>(
      async () => true,
    );
    // Still cli-missing after a "successful" global install (bin not on PATH).
    await expect(
      run({ getVercelAuthStatus: statusProbe("cli-missing", "cli-missing") }, spawnPackageManager),
    ).resolves.toEqual({ kind: "failed" });
  });

  it("uses the npm global form for an npm project", async () => {
    const spawnPackageManager = vi.fn<InstallVercelCliDeps["spawnPackageManager"]>(
      async () => true,
    );
    await run(
      {
        getVercelAuthStatus: statusProbe("cli-missing", "authenticated"),
        detectPackageManager: vi.fn(
          async (): Promise<DetectedPackageManager> => ({ kind: "npm", source: "lockfile" }),
        ),
      },
      spawnPackageManager,
    );
    expect(spawnPackageManager).toHaveBeenCalledWith(
      "npm",
      APP_ROOT,
      ["install", "-g", "vercel@latest"],
      expect.objectContaining({}),
    );
  });
});
