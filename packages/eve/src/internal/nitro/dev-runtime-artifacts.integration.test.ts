import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import {
  activateDevelopmentRuntimeArtifactsSnapshot,
  pruneDevelopmentRuntimeArtifactsSnapshots,
  publishDevelopmentRuntimeArtifactsSnapshot,
  readDevelopmentRuntimeArtifactsSnapshotRoot,
  readDevelopmentRuntimeArtifactsRevision,
  resolveDevelopmentRuntimeArtifactsPointerPath,
  stageDevelopmentRuntimeArtifactsSnapshot,
} from "#internal/nitro/dev-runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";

const createScratchDirectory = useTemporaryDirectories();

describe("development runtime artifact snapshots", () => {
  it("stages snapshots without moving the latest runtime pointer", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-artifacts-stage-");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(compileDirectoryPath, "compiled-agent-manifest.json"),
      `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`,
    );

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    expect(
      readDevelopmentRuntimeArtifactsSnapshotRoot(
        resolveDevelopmentRuntimeArtifactsPointerPath(appRoot),
      ),
    ).toBeUndefined();
    expect(readDevelopmentRuntimeArtifactsRevision(appRoot)).toEqual({
      revision: appRoot,
    });

    await activateDevelopmentRuntimeArtifactsSnapshot({ appRoot, snapshot });

    expect(readDevelopmentRuntimeArtifactsRevision(appRoot)).toEqual({
      revision: snapshot.runtimeAppRoot,
    });
  });

  it("prunes stale snapshots while preserving the active and recent snapshots", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-artifacts-prune-");
    const snapshotsRoot = join(appRoot, ".eve", "dev-runtime", "snapshots");
    const activeSnapshotRoot = join(snapshotsRoot, "active");
    const recentSnapshotRoot = join(snapshotsRoot, "recent");
    const retainedSnapshotRoot = join(snapshotsRoot, "retained");
    const staleSnapshotRoot = join(snapshotsRoot, "stale");
    const oldActiveTime = new Date(1_000);
    const now = 1_000_000;

    for (const snapshotRoot of [
      activeSnapshotRoot,
      recentSnapshotRoot,
      retainedSnapshotRoot,
      staleSnapshotRoot,
    ]) {
      await mkdir(snapshotRoot, { recursive: true });
      await writeFile(join(snapshotRoot, "marker.txt"), snapshotRoot);
    }
    await utimes(activeSnapshotRoot, oldActiveTime, oldActiveTime);
    await utimes(recentSnapshotRoot, new Date(now - 1_000), new Date(now - 1_000));
    await utimes(retainedSnapshotRoot, new Date(now - 20_000), new Date(now - 20_000));
    await utimes(staleSnapshotRoot, new Date(now - 30_000), new Date(now - 30_000));

    await activateDevelopmentRuntimeArtifactsSnapshot({
      appRoot,
      snapshot: {
        runtimeAppRoot: join(activeSnapshotRoot, "source", "app"),
        snapshotRoot: activeSnapshotRoot,
        snapshotSourceRoot: join(activeSnapshotRoot, "source"),
      },
    });

    await pruneDevelopmentRuntimeArtifactsSnapshots({
      appRoot,
      now,
      recentWindowMs: 5_000,
      retainCount: 2,
    });

    await expect(readdir(snapshotsRoot)).resolves.toEqual(
      expect.arrayContaining(["active", "recent", "retained"]),
    );
    expect(existsSync(staleSnapshotRoot)).toBe(false);
  });

  it("removes a partially staged snapshot when staging fails", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-artifacts-failed-stage-");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      manifestPath,
      `${JSON.stringify({ agentRoot: "/outside-app", appRoot }, null, 2)}\n`,
    );

    await expect(
      stageDevelopmentRuntimeArtifactsSnapshot({
        paths: { compileDirectoryPath },
        project: { appRoot },
      } as CompileAgentResult),
    ).rejects.toThrow("outside runtime app root");

    await expect(readdir(join(appRoot, ".eve", "dev-runtime", "snapshots"))).resolves.toEqual([]);
  });

  it("freezes authored source and rewrites runtime manifest roots for new sessions", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-artifacts-");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const toolPath = join(agentRoot, "tools", "get_weather.ts");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(join(agentRoot, "tools"), { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(toolPath, "export const temperature = 72;\n");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          agentRoot,
          appRoot,
          subagents: [
            {
              agent: {
                agentRoot: join(agentRoot, "subagents", "forecast"),
                appRoot,
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const snapshot = await publishDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    await writeFile(toolPath, "export const temperature = 73;\n");

    expect(
      readDevelopmentRuntimeArtifactsSnapshotRoot(
        resolveDevelopmentRuntimeArtifactsPointerPath(appRoot),
      ),
    ).toBe(snapshot.runtimeAppRoot);
    await expect(
      readFile(resolveDevelopmentRuntimeArtifactsPointerPath(appRoot), "utf8").then(
        (source) => JSON.parse(source) as Record<string, unknown>,
      ),
    ).resolves.toMatchObject({
      appRoot,
      kind: "eve-dev-runtime-artifacts-pointer",
      runtimeAppRoot: snapshot.runtimeAppRoot,
      snapshotRoot: snapshot.snapshotRoot,
      version: 2,
    });
    expect(
      resolveNitroCompiledArtifactsSource({
        appRoot,
        dev: true,
        devRuntimeArtifactsPointerPath: resolveDevelopmentRuntimeArtifactsPointerPath(appRoot),
        moduleMapLoaderPath: "/package/src/internal/authored-module-map-loader.ts",
      }),
    ).toMatchObject({
      appRoot: snapshot.runtimeAppRoot,
      kind: "disk",
    });
    await expect(
      readFile(join(snapshot.runtimeAppRoot, "agent", "tools", "get_weather.ts"), "utf8"),
    ).resolves.toBe("export const temperature = 72;\n");
    await expect(
      readFile(
        join(snapshot.runtimeAppRoot, ".eve", "compile", "compiled-agent-manifest.json"),
        "utf8",
      ),
    ).resolves.toContain(JSON.stringify(join(snapshot.runtimeAppRoot, "agent")));
  });

  it("keeps compatibility with v1 dev runtime pointers", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-artifacts-pointer-v1-");
    const runtimeAppRoot = join(appRoot, ".eve", "dev-runtime", "snapshots", "legacy");
    const pointerPath = resolveDevelopmentRuntimeArtifactsPointerPath(appRoot);

    await mkdir(join(appRoot, ".eve", "dev-runtime"), { recursive: true });
    await writeFile(
      pointerPath,
      `${JSON.stringify(
        {
          appRoot: runtimeAppRoot,
          kind: "eve-dev-runtime-artifacts-pointer",
          version: 1,
        },
        null,
        2,
      )}\n`,
    );

    expect(readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath)).toBe(runtimeAppRoot);
  });

  it("preserves workspace-relative tsconfig extends in runtime snapshots", async () => {
    const workspaceRoot = await createScratchDirectory("eve-dev-runtime-workspace-");
    const appRoot = join(workspaceRoot, "agents", "d0");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(join(workspaceRoot, "agents", "unused"), { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - agents/*\n");
    await writeFile(join(workspaceRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(workspaceRoot, "tsconfig.base.json"),
      '{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" } }\n',
    );
    await writeFile(join(workspaceRoot, "agents", "unused", "package.json"), '{"name":"unused"}\n');
    await writeFile(join(appRoot, "package.json"), '{"name":"d0-agent","type":"module"}\n');
    await writeFile(
      join(appRoot, "tsconfig.json"),
      '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "target": "ES2024" } }\n',
    );
    await writeFile(join(agentRoot, "agent.ts"), "export const answer = 42;\n");
    await writeFile(manifestPath, `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`);

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    expect(snapshot.runtimeAppRoot).toBe(join(snapshot.snapshotSourceRoot, "agents", "d0"));
    await expect(
      readFile(join(snapshot.snapshotSourceRoot, "tsconfig.base.json"), "utf8"),
    ).resolves.toContain('"module"');
    expect(existsSync(join(snapshot.snapshotSourceRoot, "agents", "unused"))).toBe(false);

    const moduleNamespace = await loadAuthoredModuleNamespace(
      join(snapshot.runtimeAppRoot, "agent", "agent.ts"),
    );

    expect(moduleNamespace.answer).toBe(42);
  });

  it("freezes local workspace packages resolved through app node_modules symlinks", async () => {
    const workspaceRoot = await createScratchDirectory("eve-dev-runtime-linked-package-");
    const appRoot = join(workspaceRoot, "apps", "agent-app");
    const agentRoot = join(appRoot, "agent");
    const packageRoot = join(workspaceRoot, "packages", "message");
    const externalPackageRoot = join(workspaceRoot, "node_modules", "external-message");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await mkdir(join(packageRoot, "node_modules"), { recursive: true });
    await mkdir(externalPackageRoot, { recursive: true });
    await mkdir(join(workspaceRoot, "packages", "unused"), { recursive: true });
    await mkdir(join(appRoot, "node_modules", "@repo"), { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(
      join(workspaceRoot, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n  - packages/*\n",
    );
    await writeFile(join(workspaceRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@repo/message": "workspace:*",
          },
          name: "agent-app",
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(appRoot, "tsconfig.json"),
      '{ "compilerOptions": { "target": "ES2024" } }\n',
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "external-message": "1.0.0",
          },
          exports: "./src/index.ts",
          name: "@repo/message",
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(externalPackageRoot, "package.json"),
      JSON.stringify(
        {
          exports: "./index.js",
          name: "external-message",
          type: "module",
          version: "1.0.0",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(externalPackageRoot, "index.js"),
      'export const externalMessage = "external";\n',
    );
    await writeFile(
      join(packageRoot, "src", "index.ts"),
      'import { externalMessage } from "external-message";\nexport const message = `snapshotted:${externalMessage}`;\n',
    );
    await writeFile(
      join(workspaceRoot, "packages", "unused", "package.json"),
      '{"name":"unused"}\n',
    );
    await symlink(packageRoot, join(appRoot, "node_modules", "@repo", "message"), "junction");
    await symlink(
      externalPackageRoot,
      join(packageRoot, "node_modules", "external-message"),
      "junction",
    );
    await writeFile(
      join(agentRoot, "agent.ts"),
      'import { message } from "@repo/message";\nexport const result = message;\n',
    );
    await writeFile(manifestPath, `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`);

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    await writeFile(join(packageRoot, "src", "index.ts"), 'export const message = "live";\n');

    expect(existsSync(join(snapshot.snapshotSourceRoot, "packages", "message"))).toBe(true);
    expect(existsSync(join(snapshot.snapshotSourceRoot, "packages", "unused"))).toBe(false);
    await expect(
      lstat(
        join(
          snapshot.snapshotSourceRoot,
          "packages",
          "message",
          "node_modules",
          "external-message",
        ),
      ).then((stats) => stats.isSymbolicLink()),
    ).resolves.toBe(true);

    const moduleNamespace = await loadAuthoredModuleNamespace(
      join(snapshot.runtimeAppRoot, "agent", "agent.ts"),
    );

    expect(moduleNamespace.result).toBe("snapshotted:external");
  });
});
