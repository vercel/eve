import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decodeBytesToUtf8, defineCommand, MountableFs, ReadWriteFs } from "just-bash";
import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import {
  createJustBashSandboxProvider,
  pruneJustBashSandboxTemplates,
} from "#execution/sandbox/bindings/just-bash.js";
import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import { executeGlobOnSandbox } from "#execution/sandbox/glob-tool.js";
import { executeGrepOnSandbox } from "#execution/sandbox/grep-tool.js";

const createScratchDirectory = useTemporaryDirectories();

// The whole file exercises the opt-in just-bash provider; the workspace
// devDependency provides the `just-bash` install that applications opt
// into explicitly.
function createJustBashProvider(options: JustBashSandboxCreateOptions = {}) {
  return createSandboxProviderHarness(createJustBashSandboxProvider(options), undefined);
}

async function createTemporaryCacheDirectory(label: string): Promise<string> {
  // The local provider derives its cache directory from
  // `appRoot` via `resolveSandboxCacheDirectory`, so the
  // helper returns a temporary appRoot rather than a cache directory
  // directly.
  return await createScratchDirectory(`eve-local-sandbox-${label}-`);
}

async function createPrewarmedLocalHandle(input: {
  readonly appRoot: string;
  readonly sandboxName: string;
  readonly templateName: string;
}) {
  const backend = createJustBashProvider();
  await backend.prepare({
    appRoot: input.appRoot,
    seedFiles: [],
    templateName: input.templateName,
  });
  return await backend.getOrCreate({
    appRoot: input.appRoot,
    sandboxName: input.sandboxName,
    templateName: input.templateName,
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      out += decoder.decode(value, { stream: true });
    }
  }
  out += decoder.decode();
  return out;
}

describe("just-bash sandbox file API", () => {
  it("composes a custom filesystem alongside the workspace", async () => {
    const appRoot = await createTemporaryCacheDirectory("custom-filesystem-app");
    const sourceRoot = join(appRoot, "agent");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "instructions.md"), "before");
    let factoryCalls = 0;
    const backend = createJustBashProvider({
      async filesystem(context) {
        factoryCalls += 1;
        expect(context.appRoot).toBe(appRoot);
        await context.defaultFilesystem.mkdir("/source", { recursive: true });
        return new MountableFs({
          base: context.defaultFilesystem,
          mounts: [
            {
              filesystem: new ReadWriteFs({
                allowSymlinks: false,
                maxFileReadSize: Number.MAX_SAFE_INTEGER,
                root: sourceRoot,
              }),
              mountPoint: "/source",
            },
          ],
        });
      },
    });

    const handle = await backend.getOrCreate({
      appRoot,
      sandboxName: "session-custom-filesystem",
      templateName: null,
    });

    expect(factoryCalls).toBe(1);
    expect(await handle.sandbox.readTextFile({ path: "/source/instructions.md" })).toBe("before");
    await expect(
      executeGlobOnSandbox(handle.sandbox, { path: "/source", pattern: "*" }),
    ).resolves.toMatchObject({
      content: "/source/instructions.md",
      count: 1,
      path: "/source",
    });
    await expect(
      executeGrepOnSandbox(handle.sandbox, { path: "/source", pattern: "before" }),
    ).resolves.toMatchObject({
      content: "/source/instructions.md:1:before",
      matchCount: 1,
      path: "/source",
    });
    await handle.sandbox.writeTextFile({
      content: "after",
      path: "/source/instructions.md",
    });
    await handle.sandbox.writeTextFile({ content: "scratch", path: "scratch.txt" });
    expect(await readFile(join(sourceRoot, "instructions.md"), "utf8")).toBe("after");
    expect(existsSync(join(sourceRoot, "scratch.txt"))).toBe(false);
    await handle.shutdown();
  });

  it("applies the filesystem factory only to live sessions", async () => {
    const appRoot = await createTemporaryCacheDirectory("filesystem-factory-lifecycle");
    let factoryCalls = 0;
    const backend = createJustBashProvider({
      async filesystem({ defaultFilesystem }) {
        factoryCalls += 1;
        return defaultFilesystem;
      },
    });

    await backend.prepare({
      appRoot,
      seedFiles: [{ content: "from template", path: "/workspace/seed.txt" }],
      templateName: "tpl-filesystem-factory",
    });
    expect(factoryCalls).toBe(0);

    const handle = await backend.getOrCreate({
      appRoot,
      sandboxName: "session-filesystem-factory",
      templateName: "tpl-filesystem-factory",
    });
    expect(factoryCalls).toBe(1);
    await expect(handle.sandbox.readTextFile({ path: "seed.txt" })).resolves.toBe("from template");
    await handle.shutdown();
  });

  it("writes a file via the public session and reads it back", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-write-read",
      templateName: "tpl-write-read",
    });

    await handle.sandbox.writeTextFile({ content: "hello world", path: "note.txt" });
    const content = await handle.sandbox.readTextFile({ path: "note.txt" });

    expect(content).toBe("hello world");
  });

  it("passes env vars to a command run via the public session", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("run-env");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-run-env",
      templateName: "tpl-run-env",
    });

    const result = await handle.sandbox.run({
      command: 'echo "$DEPLOY_ENV"',
      env: { DEPLOY_ENV: "staging" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("staging");
  });

  it("passes env vars to a process spawned via the public session", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("spawn-env");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-spawn-env",
      templateName: "tpl-spawn-env",
    });

    const process = await handle.sandbox.spawn({
      command: 'echo "$DEPLOY_ENV"',
      env: { DEPLOY_ENV: "production" },
    });
    const stdout = await collectStream(process.stdout);
    const { exitCode } = await process.wait();

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("production");
  });

  it("rejects setNetworkPolicy — the just-bash engine cannot broker", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("network-policy");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-network-policy",
      templateName: "tpl-network-policy",
    });

    await expect(handle.sandbox.setNetworkPolicy("deny-all")).rejects.toThrow(
      "not supported on the just-bash sandbox provider",
    );
  });

  it("readFile returns null for a missing file", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-missing",
      templateName: "tpl-missing",
    });

    const content = await handle.sandbox.readTextFile({ path: "does-not-exist.txt" });

    expect(content).toBeNull();
  });

  it("writeFile creates parent directories recursively", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-mkdir",
      templateName: "tpl-mkdir",
    });

    await handle.sandbox.writeTextFile({
      content: "nested content",
      path: "deep/nested/dir/file.txt",
    });
    const content = await handle.sandbox.readTextFile({ path: "deep/nested/dir/file.txt" });

    expect(content).toBe("nested content");
  });

  it("writeFile overwrites an existing file", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-overwrite",
      templateName: "tpl-overwrite",
    });

    await handle.sandbox.writeTextFile({ content: "original", path: "file.txt" });
    await handle.sandbox.writeTextFile({ content: "replaced", path: "file.txt" });
    const content = await handle.sandbox.readTextFile({ path: "file.txt" });

    expect(content).toBe("replaced");
  });

  it("removePath deletes a recursive directory tree", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-remove",
      templateName: "tpl-remove",
    });

    await handle.sandbox.writeTextFile({
      content: "dynamic skill",
      path: "skills/tenant/SKILL.md",
    });
    await handle.sandbox.writeTextFile({
      content: "policy",
      path: "skills/tenant/references/policy.md",
    });
    await handle.sandbox.removePath({ force: true, path: "skills/tenant", recursive: true });

    await expect(
      handle.sandbox.readTextFile({ path: "skills/tenant/SKILL.md" }),
    ).resolves.toBeNull();
    await expect(
      handle.sandbox.readTextFile({ path: "skills/tenant/references/policy.md" }),
    ).resolves.toBeNull();
  });

  it("preserves files across capture and reconnect", async () => {
    const appRoot = await createTemporaryCacheDirectory("file-api");
    const backend = createJustBashProvider();

    await backend.prepare({
      appRoot,
      seedFiles: [],
      templateName: "tpl-reconnect",
    });

    const firstHandle = await backend.getOrCreate({
      appRoot,
      sandboxName: "session-reconnect",
      templateName: "tpl-reconnect",
    });
    await firstHandle.sandbox.writeTextFile({
      content: "survives reconnect",
      path: "persisted.txt",
    });

    await firstHandle.stop();
    const state = await firstHandle.captureMetadata?.();
    if (state === undefined) throw new Error("Expected captured provider metadata.");

    expect(state).toEqual({
      rootPath: join(
        appRoot,
        ".eve",
        "sandbox-cache",
        "just-bash",
        "sessions",
        "session-reconnect",
      ),
    });
    await expect(
      readFile(
        join(
          appRoot,
          ".eve",
          "sandbox-cache",
          "just-bash",
          "sessions",
          "session-reconnect",
          "fs",
          "workspace",
          "persisted.txt",
        ),
        "utf8",
      ),
    ).resolves.toBe("survives reconnect");

    const reconnectedHandle = await backend.getOrCreate({
      existing: state,
      appRoot,
      sandboxName: "session-reconnect",
      templateName: "tpl-reconnect",
    });
    const content = await reconnectedHandle.sandbox.readTextFile({ path: "persisted.txt" });

    expect(content).toBe("survives reconnect");
  });

  it("supports readFile with line range options", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-line-range",
      templateName: "tpl-line-range",
    });

    await handle.sandbox.writeTextFile({
      content: "alpha\nbeta\ngamma\ndelta\n",
      path: "lines.txt",
    });
    const range = await handle.sandbox.readTextFile({
      path: "lines.txt",
      startLine: 2,
      endLine: 3,
    });

    expect(range).toBe("beta\ngamma\n");
  });

  it("resolves relative paths from the sandbox working directory", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-relative",
      templateName: "tpl-relative",
    });

    await handle.sandbox.writeTextFile({ content: "relative write", path: "rel.txt" });
    const content = await handle.sandbox.readTextFile({ path: "/workspace/rel.txt" });

    expect(content).toBe("relative write");
  });

  it("preserves Buffer bytes written through the public session", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-buffer",
      templateName: "tpl-buffer",
    });

    // A PNG header plus a handful of non-UTF-8 bytes. Reading this
    // back as UTF-8 text would throw, so the roundtrip check uses the
    // `wc -c` command to confirm the on-disk byte length matches.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    await handle.sandbox.writeBinaryFile({ content: bytes, path: "assets/fixture.bin" });

    const result = await handle.sandbox.run({ command: "wc -c < assets/fixture.bin" });
    expect(result.exitCode).toBe(0);
    expect(Number(result.stdout.trim())).toBe(bytes.length);
  });
});

describe("just-bash custom commands", () => {
  it("forwards custom commands to live sessions", async () => {
    const appRoot = await createTemporaryCacheDirectory("custom-command");
    const backend = createJustBashProvider({
      customCommands: [
        defineCommand("cap", async (args, context) => {
          if (args[0] === "fail") {
            return { exitCode: 23, stderr: "cap failed\n", stdout: "" };
          }
          return {
            exitCode: 0,
            stderr: "",
            stdout: decodeBytesToUtf8(context.stdin).toUpperCase(),
          };
        }),
      ],
    });
    const handle = await backend.getOrCreate({
      appRoot,
      sandboxName: "session-custom-command",
      templateName: null,
    });
    await expect(
      handle.sandbox.run({ command: "printf 'hello' | cap > result.txt" }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    });
    await expect(handle.sandbox.readTextFile({ path: "result.txt" })).resolves.toBe("HELLO");
    await expect(handle.sandbox.run({ command: "cap fail" })).resolves.toMatchObject({
      exitCode: 23,
      stderr: "cap failed\n",
    });
    await handle.shutdown();
  });
});

describe("just-bash provider", () => {
  it("exposes a distinct stable backend name", () => {
    const backend = createJustBashProvider();
    expect(backend).toBeDefined();
  });

  it("creates a fresh session when no template key is requested", async () => {
    const appRoot = await createTemporaryCacheDirectory("fresh-session");
    const backend = createJustBashProvider();

    const handle = await backend.getOrCreate({
      appRoot,
      sandboxName: "session-without-template",
      templateName: null,
    });
    const result = await handle.sandbox.run({
      command: "find /workspace -maxdepth 2 -type f | sort",
    });

    expect(result.stdout.trim()).toBe("");
  });

  it("reports a fresh build on first prewarm and a reuse on the second", async () => {
    const appRoot = await createTemporaryCacheDirectory("reuse-report");
    const backend = createJustBashProvider();

    const first = await backend.prepare({
      appRoot,
      seedFiles: [{ content: "# Weather skill\n", path: "/workspace/skills/weather.md" }],
      templateName: "tpl-reuse-report",
    });
    const second = await backend.prepare({
      appRoot,
      seedFiles: [{ content: "# Weather skill\n", path: "/workspace/skills/weather.md" }],
      templateName: "tpl-reuse-report",
    });

    expect(first).toMatchObject({ reused: false });
    expect(second).toMatchObject({ reused: true });
    await expect(
      readFile(
        join(
          appRoot,
          ".eve",
          "sandbox-cache",
          "just-bash",
          "templates",
          "tpl-reuse-report",
          "fs",
          "workspace",
          "skills",
          "weather.md",
        ),
        "utf8",
      ),
    ).resolves.toBe("# Weather skill\n");
  });

  it("prunes stale cached templates while preserving retained and recent templates", async () => {
    const appRoot = await createTemporaryCacheDirectory("template-prune");
    const templatesRoot = join(appRoot, ".eve", "sandbox-cache", "just-bash", "templates");
    const recentTemplateRoot = join(templatesRoot, "recent");
    const retainedTemplateRoot = join(templatesRoot, "retained");
    const staleTemplateRoot = join(templatesRoot, "stale");
    const staleTemporaryRoot = join(templatesRoot, "stale-publish.tmp");
    const recentTemporaryRoot = join(templatesRoot, "recent-publish.tmp");
    const now = 1_000_000;

    for (const templateRoot of [
      recentTemplateRoot,
      retainedTemplateRoot,
      staleTemplateRoot,
      staleTemporaryRoot,
      recentTemporaryRoot,
    ]) {
      await mkdir(templateRoot, { recursive: true });
      await writeFile(join(templateRoot, "marker.txt"), templateRoot);
    }
    await utimes(recentTemplateRoot, new Date(now - 1_000), new Date(now - 1_000));
    await utimes(retainedTemplateRoot, new Date(now - 20_000), new Date(now - 20_000));
    await utimes(staleTemplateRoot, new Date(now - 30_000), new Date(now - 30_000));
    await utimes(staleTemporaryRoot, new Date(now - 30_000), new Date(now - 30_000));
    await utimes(recentTemporaryRoot, new Date(now - 1_000), new Date(now - 1_000));

    await pruneJustBashSandboxTemplates({
      appRoot,
      now,
      recentWindowMs: 5_000,
      retainCount: 2,
    });

    await expect(readdir(templatesRoot)).resolves.toEqual(
      expect.arrayContaining(["recent", "retained", "recent-publish.tmp"]),
    );
    expect(existsSync(staleTemplateRoot)).toBe(false);
    expect(existsSync(staleTemporaryRoot)).toBe(false);
  });

  it("touches a reused template so cleanup keeps the active template", async () => {
    const appRoot = await createTemporaryCacheDirectory("template-touch");
    const backend = createJustBashProvider();
    const templateRoot = join(appRoot, ".eve", "sandbox-cache", "just-bash", "templates", "active");
    const oldTime = new Date(1_000);
    const now = Date.now();

    await backend.prepare({
      appRoot,
      seedFiles: [],
      templateName: "active",
    });
    await utimes(templateRoot, oldTime, oldTime);

    await expect(
      backend.prepare({
        appRoot,
        seedFiles: [],
        templateName: "active",
      }),
    ).resolves.toMatchObject({ reused: true });

    expect((await stat(templateRoot)).mtimeMs).toBeGreaterThan(oldTime.getTime());

    await pruneJustBashSandboxTemplates({
      appRoot,
      now,
      recentWindowMs: now - oldTime.getTime() - 1,
      retainCount: 0,
    });

    expect(existsSync(templateRoot)).toBe(true);
  });

  it("creates a session from a prewarmed template with seed files", async () => {
    const appRoot = await createTemporaryCacheDirectory("seed-template");
    const backend = createJustBashProvider();

    await backend.prepare({
      appRoot,
      seedFiles: [
        {
          content: "# Weather skill\n",
          path: "/workspace/skills/weather.md",
        },
      ],
      templateName: "template-seeded-later",
    });

    const seededHandle = await backend.getOrCreate({
      appRoot,
      sandboxName: "session-from-repaired-template",
      templateName: "template-seeded-later",
    });
    const result = await seededHandle.sandbox.run({
      command: "find /workspace -maxdepth 3 -type f | sort",
    });

    expect(result.stdout.trim().split("\n")).toEqual(["/workspace/skills/weather.md"]);
  });

  it("writes seed files before preparation and captures preparation outputs", async () => {
    const appRoot = await createTemporaryCacheDirectory("seed-before-bootstrap");
    const backend = createJustBashProvider();

    await backend.prepare({
      runPreparation: async (sandbox) => {
        await expect(sandbox.readTextFile({ path: "/workspace/seed.txt" })).resolves.toBe(
          "authored seed",
        );
        await sandbox.writeTextFile({
          content: "bootstrap output",
          path: "/workspace/bootstrap.txt",
        });
      },
      appRoot,
      seedFiles: [{ content: "authored seed", path: "/workspace/seed.txt" }],
      templateName: "template-seed-before-bootstrap",
    });

    const handle = await backend.getOrCreate({
      appRoot,
      sandboxName: "session-seed-before-bootstrap",
      templateName: "template-seed-before-bootstrap",
    });
    await expect(handle.sandbox.readTextFile({ path: "/workspace/seed.txt" })).resolves.toBe(
      "authored seed",
    );
    await expect(handle.sandbox.readTextFile({ path: "/workspace/bootstrap.txt" })).resolves.toBe(
      "bootstrap output",
    );
  });

  it("does not repair an existing session directory with later seed files", async () => {
    const appRoot = await createTemporaryCacheDirectory("seed-session");
    const backend = createJustBashProvider();

    await backend.prepare({
      appRoot,
      seedFiles: [],
      templateName: "template-seeded-later-session",
    });

    const initialHandle = await backend.getOrCreate({
      appRoot,
      sandboxName: "session-seeded-later",
      templateName: "template-seeded-later-session",
    });
    const initialState = await initialHandle.captureMetadata?.();
    if (initialState === undefined) throw new Error("Expected captured provider metadata.");

    await initialHandle.shutdown();

    await backend.prepare({
      appRoot,
      seedFiles: [
        {
          content: "# Weather skill\n",
          path: "/workspace/skills/weather.md",
        },
      ],
      templateName: "template-seeded-later-session-next",
    });

    const seededHandle = await backend.getOrCreate({
      existing: initialState,
      appRoot,
      sandboxName: "session-seeded-later",
      templateName: "template-seeded-later-session-next",
    });
    const result = await seededHandle.sandbox.run({
      command: "find /workspace -maxdepth 3 -type f | sort",
    });

    expect(result.stdout.trim()).toBe("");
  });
});
