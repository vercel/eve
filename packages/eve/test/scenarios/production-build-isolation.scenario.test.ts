import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();
const PROCESS_DEADLINE_MS = 180_000;
const SCENARIO_DEADLINE_MS = 360_000;

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface RunningProcess {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly result: Promise<ProcessResult>;
  readonly stderr: () => string;
  readonly stdout: () => string;
  stop(): Promise<void>;
}

interface RunningDevServer extends RunningProcess {
  readonly url: string;
}

function startEveProcess(input: {
  readonly appRoot: string;
  readonly args: readonly string[];
}): RunningProcess {
  const eveBinPath = join(input.appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(process.execPath, [eveBinPath, ...input.args], {
    cwd: input.appRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      VERCEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const result = new Promise<ProcessResult>((resolvePromise, reject) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          [
            `Timed out waiting for eve ${input.args.join(" ")}.`,
            `stdout:\n${stdout}`,
            `stderr:\n${stderr}`,
          ].join("\n\n"),
        ),
      );
    }, PROCESS_DEADLINE_MS);

    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      resolvePromise({ code, signal, stderr, stdout });
    });
  });

  return {
    child,
    result,
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        await result.catch(() => undefined);
        return;
      }

      await new Promise<void>((resolvePromise) => {
        const deadline = setTimeout(() => {
          child.kill("SIGKILL");
          resolvePromise();
        }, 10_000);
        child.once("exit", () => {
          clearTimeout(deadline);
          resolvePromise();
        });
        child.kill("SIGTERM");
      });
      await result.catch(() => undefined);
    },
  };
}

function stripAnsi(text: string): string {
  return text
    .split("\u001b[")
    .map((segment, index) => (index === 0 ? segment : segment.replace(/^[0-9;]*m/, "")))
    .join("");
}

function parseServerUrl(stdout: string): string | undefined {
  return /server listening at (https?:\/\/\S+)/.exec(stripAnsi(stdout))?.[1];
}

async function startEveDev(appRoot: string): Promise<RunningDevServer> {
  const processHandle = startEveProcess({
    appRoot,
    args: ["dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
  });
  const url = await new Promise<string>((resolvePromise, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {
      settleReject(
        new Error(
          [
            "Timed out waiting for eve dev readiness.",
            `stdout:\n${processHandle.stdout()}`,
            `stderr:\n${processHandle.stderr()}`,
          ].join("\n\n"),
        ),
      );
    }, 120_000);

    const cleanup = () => {
      clearTimeout(deadline);
      processHandle.child.stdout.off("data", checkOutput);
      processHandle.child.stderr.off("data", checkOutput);
      processHandle.child.off("exit", handleExit);
    };
    const settleResolve = (serverUrl: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise(serverUrl);
    };
    function settleReject(error: unknown) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }
    function checkOutput() {
      const serverUrl = parseServerUrl(processHandle.stdout());
      if (serverUrl !== undefined) {
        settleResolve(serverUrl);
      }
    }
    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      settleReject(
        new Error(
          [
            `eve dev exited before readiness (code ${String(code)}, signal ${String(signal)}).`,
            `stdout:\n${processHandle.stdout()}`,
            `stderr:\n${processHandle.stderr()}`,
          ].join("\n\n"),
        ),
      );
    }

    processHandle.child.stdout.on("data", checkOutput);
    processHandle.child.stderr.on("data", checkOutput);
    processHandle.child.once("exit", handleExit);
    checkOutput();
  }).catch(async (error: unknown) => {
    await processHandle.stop();
    throw error;
  });

  return { ...processHandle, url };
}

async function expectHealthy(server: RunningDevServer): Promise<void> {
  const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url), {
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.text();
  expect(
    response.status,
    [
      `Expected ${EVE_HEALTH_ROUTE_PATH} to remain healthy.`,
      `response:\n${body}`,
      `stdout:\n${server.stdout()}`,
      `stderr:\n${server.stderr()}`,
    ].join("\n\n"),
  ).toBe(200);
}

async function observeConcurrentBuildWorkspaces(input: {
  readonly appRoot: string;
  readonly builds: readonly RunningProcess[];
}): Promise<readonly string[]> {
  const buildsRoot = join(input.appRoot, ".eve", "builds");
  await mkdir(buildsRoot, { recursive: true });

  return await new Promise<readonly string[]>((resolvePromise, reject) => {
    let settled = false;
    let checking = false;
    const deadline = setTimeout(() => {
      settleReject(
        new Error(
          [
            "Timed out waiting for two invocation-owned build workspaces.",
            ...input.builds.flatMap((build, index) => [
              `build ${index + 1} stdout:\n${build.stdout()}`,
              `build ${index + 1} stderr:\n${build.stderr()}`,
            ]),
          ].join("\n\n"),
        ),
      );
    }, 120_000);
    const watcher = watch(buildsRoot, () => {
      void check();
    });
    const cleanup = () => {
      clearTimeout(deadline);
      watcher.close();
      for (const build of input.builds) {
        build.child.off("exit", checkAfterExit);
      }
    };
    const settleResolve = (workspaces: readonly string[]) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise(workspaces);
    };
    function settleReject(error: unknown) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }
    async function check() {
      if (settled || checking) {
        return;
      }
      checking = true;
      try {
        const workspaces = (
          await readdir(buildsRoot, {
            withFileTypes: true,
          })
        )
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
        if (workspaces.length >= 2) {
          settleResolve(workspaces);
          return;
        }
        if (
          input.builds.every(
            (build) => build.child.exitCode !== null || build.child.signalCode !== null,
          )
        ) {
          settleReject(
            new Error(
              [
                `Both builds exited before two workspaces overlapped; observed ${workspaces.length}.`,
                ...input.builds.flatMap((build, index) => [
                  `build ${index + 1} stdout:\n${build.stdout()}`,
                  `build ${index + 1} stderr:\n${build.stderr()}`,
                ]),
              ].join("\n\n"),
            ),
          );
        }
      } catch (error) {
        settleReject(error);
      } finally {
        checking = false;
      }
    }
    function checkAfterExit() {
      void check();
    }

    for (const build of input.builds) {
      build.child.on("exit", checkAfterExit);
    }
    void check();
  });
}

async function watchActiveDevHostWorkspace(appRoot: string): Promise<{
  readonly events: readonly string[];
  readonly initialHash: string;
  readonly name: string;
  readonly path: string;
  close(): void;
}> {
  const devHostsRoot = join(appRoot, ".eve", "dev-hosts");
  const workspaces = (await readdir(devHostsRoot, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  expect(workspaces.map((entry) => entry.name)).toHaveLength(1);
  const name = workspaces[0]!.name;
  const path = join(devHostsRoot, name);
  const events: string[] = [];
  const watcher = watch(path, { recursive: true }, (eventType, filename) => {
    events.push(`${eventType}:${filename?.toString() ?? ""}`);
  });

  return {
    events,
    initialHash: await hashPath(path),
    name,
    path,
    close() {
      watcher.close();
    },
  };
}

async function hashPath(path: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(currentPath: string, logicalPath: string): Promise<void> {
    const stats = await lstat(currentPath);
    if (stats.isSymbolicLink()) {
      hash.update(`link:${logicalPath}:${await readlink(currentPath)}\0`);
      return;
    }
    if (stats.isDirectory()) {
      hash.update(`directory:${logicalPath}\0`);
      const entries = await readdir(currentPath);
      entries.sort();
      for (const entry of entries) {
        await visit(join(currentPath, entry), join(logicalPath, entry));
      }
      return;
    }
    hash.update(`file:${logicalPath}:${stats.mode}\0`);
    hash.update(await readFile(currentPath));
    hash.update("\0");
  }

  await visit(path, ".");
  return hash.digest("hex");
}

async function listBuildWorkspaces(appRoot: string): Promise<readonly string[]> {
  try {
    return await readdir(join(appRoot, ".eve", "builds"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

interface PublishedCompilationState {
  readonly sourceGraphHash: string;
}

async function readPublishedCompilationState(appRoot: string): Promise<PublishedCompilationState> {
  const metadataPath = join(appRoot, ".output", ".eve", "compile", "compile-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    compile: { moduleMap: { path: string } };
    discovery: {
      diagnostics: { path: string };
      manifest: { path: string };
      sourceGraphHash: string;
    };
  };
  const artifactPaths = [
    metadata.compile.moduleMap.path,
    metadata.discovery.diagnostics.path,
    metadata.discovery.manifest.path,
  ];
  for (const artifactPath of artifactPaths) {
    expect(artifactPath).not.toContain(".eve/builds/");
    expect((await lstat(join(appRoot, artifactPath))).isFile()).toBe(true);
  }

  const moduleMapPath = join(appRoot, metadata.compile.moduleMap.path);
  const moduleMap = (await import(`${pathToFileURL(moduleMapPath).href}?test=${Date.now()}`)) as {
    moduleMap: { nodes: Record<string, unknown> };
  };
  expect(Object.keys(moduleMap.moduleMap.nodes)).not.toHaveLength(0);

  const serverSource = await readFile(join(appRoot, ".output", "server", "index.mjs"), "utf8");
  expect(serverSource).not.toContain("__eveInstallCompiledArtifactsStep");

  return {
    sourceGraphHash: metadata.discovery.sourceGraphHash,
  };
}

describe("production build isolation", () => {
  it(
    "keeps a real dev server healthy while two real builds overlap in invocation-owned workspaces",
    async () => {
      const app = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      const processes: RunningProcess[] = [];
      let continueProbing = false;
      let healthProbe: Promise<number> | undefined;
      let devHostWatcher: Awaited<ReturnType<typeof watchActiveDevHostWorkspace>> | undefined;

      try {
        await expectHealthy(server);
        devHostWatcher = await watchActiveDevHostWorkspace(app.appRoot);
        const builds = [
          startEveProcess({ appRoot: app.appRoot, args: ["build"] }),
          startEveProcess({ appRoot: app.appRoot, args: ["build"] }),
        ];
        processes.push(...builds);
        continueProbing = true;
        healthProbe = (async () => {
          let healthChecks = 0;
          while (continueProbing) {
            await expectHealthy(server);
            healthChecks += 1;
            await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
          }
          return healthChecks;
        })();

        const [workspaces, results] = await Promise.race([
          Promise.all([
            observeConcurrentBuildWorkspaces({
              appRoot: app.appRoot,
              builds,
            }),
            Promise.all(builds.map((build) => build.result)),
          ]),
          healthProbe.then(() => {
            throw new Error("Health probing stopped before the builds completed.");
          }),
        ]);
        continueProbing = false;
        const healthChecks = await healthProbe;
        devHostWatcher.close();

        expect(workspaces).toHaveLength(2);
        expect(results.map((result) => result.code)).toEqual([0, 0]);
        expect(results.map((result) => result.signal)).toEqual([null, null]);
        expect(healthChecks).toBeGreaterThan(0);
        expect(devHostWatcher.events).toEqual([]);
        expect(await hashPath(devHostWatcher.path)).toBe(devHostWatcher.initialHash);
        expect(
          (await readdir(join(app.appRoot, ".eve", "dev-hosts"), { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
        ).toEqual([devHostWatcher.name]);
        expect(await listBuildWorkspaces(app.appRoot)).toEqual([]);
        await expectHealthy(server);
      } finally {
        continueProbing = false;
        await healthProbe?.catch(() => undefined);
        devHostWatcher?.close();
        await Promise.all(processes.map((processHandle) => processHandle.stop()));
        await server.stop();
      }
    },
    SCENARIO_DEADLINE_MS,
  );

  it(
    "preserves the byte-for-byte last-good output when a later real bundle fails",
    async () => {
      const app = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
      const successfulBuild = startEveProcess({ appRoot: app.appRoot, args: ["build"] });
      const successfulResult = await successfulBuild.result;
      expect(successfulResult.code).toBe(0);
      expect(successfulResult.signal).toBeNull();

      const outputDir = join(app.appRoot, ".output");
      const summaryPath = join(app.appRoot, ".eve", "agent-summary.json");
      const lastGoodOutputHash = await hashPath(outputDir);
      const lastGoodSummaryHash = await hashPath(summaryPath);
      await writeFile(
        join(app.appRoot, "agent", "tools", "broken.ts"),
        [
          'import { missing } from "./does-not-exist";',
          "export default {",
          '  description: "Force the production bundle to fail.",',
          '  inputSchema: { type: "object", properties: {}, required: [] },',
          "  execute: async () => missing,",
          "};",
          "",
        ].join("\n"),
      );

      const failedBuild = startEveProcess({ appRoot: app.appRoot, args: ["build"] });
      const failedResult = await failedBuild.result;

      expect(failedResult.code).toBe(1);
      expect(failedResult.signal).toBeNull();
      expect(failedResult.stderr).toContain("does-not-exist");
      expect(await hashPath(outputDir)).toBe(lastGoodOutputHash);
      expect(await hashPath(summaryPath)).toBe(lastGoodSummaryHash);
      expect(await listBuildWorkspaces(app.appRoot)).toEqual([]);
    },
    SCENARIO_DEADLINE_MS,
  );

  it(
    "recovers a crashed publication through a real build while a real dev server stays healthy",
    async () => {
      const app = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
      const firstBuild = startEveProcess({ appRoot: app.appRoot, args: ["build"] });
      await expect(firstBuild.result).resolves.toMatchObject({ code: 0, signal: null });

      const outputDir = join(app.appRoot, ".output");
      const summaryPath = join(app.appRoot, ".eve", "agent-summary.json");
      const token = "crashed-publisher";
      const outputBackupPath = `${outputDir}.eve-backup-${token}`;
      const summaryBackupPath = `${summaryPath}.eve-backup-${token}`;
      const crashedWorkspace = join(app.appRoot, ".eve", "builds", "crashed");
      const crashedStagedOutputDir = join(crashedWorkspace, "output");
      const crashedStagedSummaryPath = join(crashedWorkspace, "agent-summary.json");
      await mkdir(crashedStagedOutputDir, { recursive: true });
      await writeFile(join(crashedStagedOutputDir, "marker.txt"), "crashed\n");
      await writeFile(crashedStagedSummaryPath, "crashed\n");
      await rename(outputDir, outputBackupPath);
      await rename(summaryPath, summaryBackupPath);
      const lockPath = join(app.appRoot, ".eve", "locks", "output-publication.lock");
      await mkdir(lockPath, { recursive: true });
      const journalPath = join(lockPath, "owner.json");
      await writeFile(
        journalPath,
        `${JSON.stringify({
          finalOutputDir: outputDir,
          finalSummaryPath: summaryPath,
          hadOutput: true,
          hadSummary: true,
          liveness: "active",
          outputBackupPath,
          phase: "backed-up",
          // This test's own live pid simulates pid reuse after a crash: only
          // the stale journal mtime marks the recorded owner as dead.
          pid: process.pid,
          scratchDir: crashedWorkspace,
          stagedOutputDir: crashedStagedOutputDir,
          stagedSummaryPath: crashedStagedSummaryPath,
          summaryBackupPath,
          token,
        })}\n`,
      );
      const staleTime = new Date(Date.now() - 60_000);
      await utimes(journalPath, staleTime, staleTime);

      const server = await startEveDev(app.appRoot);
      try {
        await expectHealthy(server);
        const recoveringBuild = startEveProcess({ appRoot: app.appRoot, args: ["build"] });
        await expect(recoveringBuild.result).resolves.toMatchObject({ code: 0, signal: null });
        await expectHealthy(server);
      } finally {
        await server.stop();
      }

      expect(await readdir(join(app.appRoot, ".eve", "locks"))).toEqual([]);
      expect(await listBuildWorkspaces(app.appRoot)).toEqual([]);
      await expect(lstat(outputBackupPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(join(outputDir, "server", "index.mjs"))).isFile()).toBe(true);
    },
    SCENARIO_DEADLINE_MS,
  );

  it(
    "publishes relocatable compiler artifacts without workspace-derived step ids",
    async () => {
      const app = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);

      const firstBuild = startEveProcess({ appRoot: app.appRoot, args: ["build"] });
      await expect(firstBuild.result).resolves.toMatchObject({ code: 0, signal: null });
      const firstCompilation = await readPublishedCompilationState(app.appRoot);

      const secondBuild = startEveProcess({ appRoot: app.appRoot, args: ["build"] });
      await expect(secondBuild.result).resolves.toMatchObject({ code: 0, signal: null });
      const secondCompilation = await readPublishedCompilationState(app.appRoot);

      expect(secondCompilation).toEqual(firstCompilation);
      expect(await listBuildWorkspaces(app.appRoot)).toEqual([]);
    },
    SCENARIO_DEADLINE_MS,
  );
});
