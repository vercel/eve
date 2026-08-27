import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDevDiagnosticDump,
  measureSessionsDirectory,
  type DevEnvironmentInfo,
} from "./diagnostic-dump.js";

const ENVIRONMENT: DevEnvironmentInfo = {
  eveVersion: "0.9.9",
  nodeVersion: "v24.0.0",
  platform: "darwin arm64",
  vercelCliVersion: "48.1.0",
  vercelCliPath: "/usr/local/bin/vercel",
  sessionsDirectory: { path: ".eve/.workflow-data", files: 12, bytes: 2048 },
};

describe("createDevDiagnosticDump", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.map((root) =>
        rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
    );
    roots.length = 0;
  });

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "eve-dump-"));
    roots.push(root);
    await mkdir(join(root, ".eve", "logs"), { recursive: true });
    return root;
  }

  it("derives the dump path from the log instance and writes environment + stats", async () => {
    const root = await makeRoot();
    const logPath = join(root, ".eve", "logs", "dev-2026-07-17T12-00-00.000Z-123.log");
    let nowMs = new Date("2026-07-17T12:00:00.000Z").getTime();

    const dump = createDevDiagnosticDump(root, logPath, {
      environment: () => Promise.resolve(ENVIRONMENT),
      now: () => new Date(nowMs),
    });
    // Let the environment collection promise settle its write.
    await new Promise((resolve) => setTimeout(resolve, 0));

    nowMs += 95_000;
    dump.updateSessionStats({
      prompts: 2,
      inputTokens: 140,
      outputTokens: 25,
      toolCalls: { bash: 2, weather: 1 },
      subagents: 1,
    });
    await dump.close();

    expect(dump.path).toBe(join(root, ".eve", "logs", "dev-2026-07-17T12-00-00.000Z-123.dump"));
    expect(dump.displayPath).toBe(".eve/logs/dev-2026-07-17T12-00-00.000Z-123.dump");
    if (process.platform !== "win32") {
      // POSIX permission bits only: Windows reports 0o666 and uses ACLs.
      expect((await stat(dump.path)).mode & 0o777).toBe(0o600);
    }

    const content = await readFile(dump.path, "utf8");
    expect(JSON.parse(content)).toEqual({
      updatedAt: "2026-07-17T12:01:35.000Z",
      durationMs: 95_000,
      environment: ENVIRONMENT,
      session: {
        prompts: 2,
        inputTokens: 140,
        outputTokens: 25,
        toolCalls: { bash: 2, weather: 1 },
        subagents: 1,
      },
    });
  });

  it("keeps a pending marker when environment collection fails", async () => {
    const root = await makeRoot();
    const logPath = join(root, ".eve", "logs", "dev-2026-07-17T12-00-00.000Z-9.log");

    const dump = createDevDiagnosticDump(root, logPath, {
      environment: () => Promise.reject(new Error("no network")),
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await dump.close();

    expect(JSON.parse(await readFile(dump.path, "utf8"))).toMatchObject({
      environment: null,
      session: null,
    });
  });
});

describe("measureSessionsDirectory", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it("measures the local sessions directory when present", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-dump-env-"));
    roots.push(root);
    const dataDir = join(root, ".eve", ".workflow-data", "runs");
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "wrun_1.json"), "0123456789");
    await writeFile(join(dataDir, "wrun_2.json"), "01234");

    expect(await measureSessionsDirectory(root)).toEqual({
      path: ".eve/.workflow-data",
      files: 2,
      bytes: 15,
    });
  });

  it("returns undefined when the store does not exist yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-dump-env-"));
    roots.push(root);

    expect(await measureSessionsDirectory(root)).toBeUndefined();
  });
});
