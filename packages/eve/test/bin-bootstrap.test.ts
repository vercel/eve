import { describe, expect, it, vi } from "vitest";

import { ensureBuiltCli, runEveCli } from "../bin/eve.js";

const bootstrapOptions = {
  cliEntrypointPath: "/workspace/packages/eve/dist/src/cli/run.js",
  packageRoot: "/workspace/packages/eve",
  postBuildScriptPaths: [
    "/workspace/packages/eve/scripts/copy-compiled-assets.mjs",
    "/workspace/packages/eve/scripts/copy-docs.mjs",
    "/workspace/packages/eve/scripts/stamp-version-tokens.mjs",
  ],
  tsgoCliPath: "/workspace/node_modules/@typescript/native-preview/bin/tsgo.js",
};
const workspaceBuildInputPaths = new Set([
  ...bootstrapOptions.postBuildScriptPaths,
  `${bootstrapOptions.packageRoot}/bin`,
  `${bootstrapOptions.packageRoot}/src`,
  `${bootstrapOptions.packageRoot}/tsconfig.json`,
]);

describe("eve CLI bootstrap", () => {
  it("fails before bootstrapping when Node.js is older than 24", async () => {
    const exists = vi.fn(async () => true);
    const importModule = vi.fn(async () => ({
      runCli: vi.fn(async () => {}),
    }));
    const runCommand = vi.fn(async () => {});

    await expect(
      runEveCli(["info"], bootstrapOptions, {
        exists,
        importModule,
        nodeVersion: "v23.11.0",
        runCommand,
      }),
    ).rejects.toThrow(
      "eve requires Node.js >=24. You are running v23.11.0. " +
        "Please install a compatible Node.js version and try again.",
    );

    expect(exists).not.toHaveBeenCalled();
    expect(importModule).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each(["v24.0.0-rc.1", "v24garbage"])(
    "rejects %s when it does not satisfy eve's package engine",
    async (nodeVersion) => {
      const exists = vi.fn(async () => true);
      const importModule = vi.fn(async () => ({
        runCli: vi.fn(async () => {}),
      }));
      const runCommand = vi.fn(async () => {});

      await expect(
        runEveCli(["info"], bootstrapOptions, {
          exists,
          importModule,
          nodeVersion,
          runCommand,
        }),
      ).rejects.toThrow(`You are running ${nodeVersion}.`);

      expect(exists).not.toHaveBeenCalled();
      expect(importModule).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it("enforces upper bounds and gaps in the package engine range", async () => {
    const exists = vi.fn(async () => true);
    const importModule = vi.fn(async () => ({
      runCli: vi.fn(async () => {}),
    }));

    await expect(
      runEveCli(["info"], bootstrapOptions, {
        exists,
        importModule,
        nodeEngineRequirement: ">=24 <26",
        nodeVersion: "v26.0.0",
      }),
    ).rejects.toThrow("eve requires Node.js >=24 <26. You are running v26.0.0.");

    expect(exists).not.toHaveBeenCalled();
    expect(importModule).not.toHaveBeenCalled();
  });

  it("imports the compiled CLI when build output already exists", async () => {
    const runCli = vi.fn(async () => {});
    const exists = vi.fn(async () => true);
    const getLatestBuildInputMtimeMs = vi.fn(async () => 100);
    const getPathMtimeMs = vi.fn(async () => 200);
    const importModule = vi.fn(async () => ({
      runCli,
    }));
    const runCommand = vi.fn(async () => {});

    await runEveCli(["info"], bootstrapOptions, {
      exists,
      getLatestBuildInputMtimeMs,
      getPathMtimeMs,
      importModule,
      runCommand,
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(importModule).toHaveBeenCalledWith("file:///workspace/packages/eve/dist/src/cli/run.js");
    expect(runCli).toHaveBeenCalledWith(["info"]);
  });

  it("builds the CLI before importing when output is missing", async () => {
    const runCli = vi.fn(async () => {});
    let cliEntrypointExists = false;
    const exists = vi.fn(async (path: string) => {
      if (path === bootstrapOptions.cliEntrypointPath) {
        return cliEntrypointExists;
      }

      return workspaceBuildInputPaths.has(path);
    });
    const importModule = vi.fn(async () => ({
      runCli,
    }));
    const runCommand = vi.fn(async () => {
      cliEntrypointExists = true;
    });

    await runEveCli(["build"], bootstrapOptions, {
      exists,
      importModule,
      runCommand,
    });

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      [bootstrapOptions.tsgoCliPath, "-p", "tsconfig.json"],
      {
        cwd: bootstrapOptions.packageRoot,
      },
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      [bootstrapOptions.postBuildScriptPaths[0]],
      {
        cwd: bootstrapOptions.packageRoot,
      },
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      3,
      process.execPath,
      [bootstrapOptions.postBuildScriptPaths[1]],
      {
        cwd: bootstrapOptions.packageRoot,
      },
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      4,
      process.execPath,
      [bootstrapOptions.postBuildScriptPaths[2]],
      {
        cwd: bootstrapOptions.packageRoot,
      },
    );
    expect(importModule).toHaveBeenCalledWith("file:///workspace/packages/eve/dist/src/cli/run.js");
    expect(runCli).toHaveBeenCalledWith(["build"]);
  });

  it("rebuilds the CLI when the compiled output is stale", async () => {
    const runCli = vi.fn(async () => {});
    const exists = vi.fn().mockResolvedValue(true);
    const getLatestBuildInputMtimeMs = vi.fn(async () => 200);
    const getPathMtimeMs = vi.fn(async () => 100);
    const importModule = vi.fn(async () => ({
      runCli,
    }));
    const runCommand = vi.fn(async () => {});

    await runEveCli(["dev"], bootstrapOptions, {
      exists,
      getLatestBuildInputMtimeMs,
      getPathMtimeMs,
      importModule,
      runCommand,
    });

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      [bootstrapOptions.tsgoCliPath, "-p", "tsconfig.json"],
      {
        cwd: bootstrapOptions.packageRoot,
      },
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      [bootstrapOptions.postBuildScriptPaths[0]],
      {
        cwd: bootstrapOptions.packageRoot,
      },
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      3,
      process.execPath,
      [bootstrapOptions.postBuildScriptPaths[1]],
      {
        cwd: bootstrapOptions.packageRoot,
      },
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      4,
      process.execPath,
      [bootstrapOptions.postBuildScriptPaths[2]],
      {
        cwd: bootstrapOptions.packageRoot,
      },
    );
    expect(importModule).toHaveBeenCalledWith("file:///workspace/packages/eve/dist/src/cli/run.js");
    expect(runCli).toHaveBeenCalledWith(["dev"]);
  });

  it("trusts packaged build output when workspace sources are not installed", async () => {
    const runCli = vi.fn(async () => {});
    const exists = vi.fn(async (path: string) => path === bootstrapOptions.cliEntrypointPath);
    const getLatestBuildInputMtimeMs = vi.fn(async () => 200);
    const getPathMtimeMs = vi.fn(async () => 100);
    const importModule = vi.fn(async () => ({
      runCli,
    }));
    const runCommand = vi.fn(async () => {});

    await runEveCli(["info"], bootstrapOptions, {
      exists,
      getLatestBuildInputMtimeMs,
      getPathMtimeMs,
      importModule,
      runCommand,
    });

    expect(getLatestBuildInputMtimeMs).not.toHaveBeenCalled();
    expect(getPathMtimeMs).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(importModule).toHaveBeenCalledWith("file:///workspace/packages/eve/dist/src/cli/run.js");
    expect(runCli).toHaveBeenCalledWith(["info"]);
  });

  it("fails when the CLI is missing from a packaged install", async () => {
    const exists = vi.fn(async () => false);
    const runCommand = vi.fn(async () => {});

    await expect(
      ensureBuiltCli(bootstrapOptions, {
        exists,
        runCommand,
      }),
    ).rejects.toThrow(
      `eve package at ${bootstrapOptions.packageRoot} does not include the sources required to rebuild the CLI.`,
    );

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails when a bootstrap build does not create the CLI entrypoint", async () => {
    const exists = vi.fn(async (path: string) => workspaceBuildInputPaths.has(path));
    const runCommand = vi.fn(async () => {});

    await expect(
      ensureBuiltCli(bootstrapOptions, {
        exists,
        runCommand,
      }),
    ).rejects.toThrow(`Building eve did not produce ${bootstrapOptions.cliEntrypointPath}.`);
  });
});
