import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decodeBytesToUtf8, defineCommand, MountableFs, ReadWriteFs } from "just-bash";
import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { createJustBashSandboxProvider } from "#execution/sandbox/bindings/just-bash.js";
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
}) {
  const provider = createJustBashProvider();
  await provider.prepare({
    appRoot: input.appRoot,
    seedFiles: [],
  });
  return await provider.openSession({
    appRoot: input.appRoot,
    sandboxName: input.sandboxName,
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
    const provider = createJustBashProvider({
      async filesystem(context) {
        factoryCalls += 1;
        expect(context.resolveProjectPath(".")).toBe(appRoot);
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

    const handle = await provider.openSession({
      appRoot,
      sandboxName: "session-custom-filesystem",
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
    await handle.onRuntimeShutdown();
  });

  it("applies the filesystem factory only to live sessions", async () => {
    const appRoot = await createTemporaryCacheDirectory("filesystem-factory-lifecycle");
    let factoryCalls = 0;
    const provider = createJustBashProvider({
      async filesystem({ defaultFilesystem }) {
        factoryCalls += 1;
        return defaultFilesystem;
      },
    });

    await provider.prepare({
      appRoot,
      seedFiles: [{ content: "from template", path: "/workspace/seed.txt" }],
    });
    expect(factoryCalls).toBe(0);

    const handle = await provider.openSession({
      appRoot,
      sandboxName: "session-filesystem-factory",
    });
    expect(factoryCalls).toBe(1);
    await expect(handle.sandbox.readTextFile({ path: "seed.txt" })).resolves.toBe("from template");
    await handle.onRuntimeShutdown();
  });

  it("writes a file via the public session and reads it back", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-write-read",
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

  it("readFile returns null for a missing file", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-missing",
    });

    const content = await handle.sandbox.readTextFile({ path: "does-not-exist.txt" });

    expect(content).toBeNull();
  });

  it("writeFile creates parent directories recursively", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-mkdir",
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
    const provider = createJustBashProvider();

    await provider.prepare({
      appRoot,
      seedFiles: [],
    });

    const { handle: firstHandle, state } = await provider.start({
      appRoot,
      sandboxName: "session-reconnect",
    });
    await firstHandle.sandbox.writeTextFile({
      content: "survives reconnect",
      path: "persisted.txt",
    });

    await firstHandle.onSessionStop();

    expect(state).toMatchObject({ version: 2 });
    await expect(
      readFile(join(state.rootPath, "fs", "workspace", "persisted.txt"), "utf8"),
    ).resolves.toBe("survives reconnect");

    const reconnectedHandle = await provider.openSession({
      existing: state,
      appRoot,
      sandboxName: "session-reconnect",
    });
    const content = await reconnectedHandle.sandbox.readTextFile({ path: "persisted.txt" });

    expect(content).toBe("survives reconnect");
  });

  it("supports readFile with line range options", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sandboxName: "session-line-range",
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
    const provider = createJustBashProvider({
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
    const handle = await provider.openSession({
      appRoot,
      sandboxName: "session-custom-command",
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
    await handle.onRuntimeShutdown();
  });
});

describe("just-bash provider", () => {
  it("exposes a distinct stable provider name", () => {
    const provider = createJustBashProvider();
    expect(provider).toBeDefined();
  });

  it("creates a fresh session when no template key is requested", async () => {
    const appRoot = await createTemporaryCacheDirectory("fresh-session");
    const provider = createJustBashProvider();

    const handle = await provider.openSession({
      appRoot,
      sandboxName: "session-without-template",
    });
    const result = await handle.sandbox.run({
      command: "find /workspace -maxdepth 2 -type f | sort",
    });

    expect(result.stdout.trim()).toBe("");
  });

  it("creates a session from a prewarmed template with seed files", async () => {
    const appRoot = await createTemporaryCacheDirectory("seed-template");
    const provider = createJustBashProvider();

    await provider.prepare({
      appRoot,
      seedFiles: [
        {
          content: "# Weather skill\n",
          path: "/workspace/skills/weather.md",
        },
      ],
    });

    const seededHandle = await provider.openSession({
      appRoot,
      sandboxName: "session-from-repaired-template",
    });
    const result = await seededHandle.sandbox.run({
      command: "find /workspace -maxdepth 3 -type f | sort",
    });

    expect(result.stdout.trim().split("\n")).toEqual(["/workspace/skills/weather.md"]);
  });

  it("rejects existing session state from a different prepared artifact", async () => {
    const appRoot = await createTemporaryCacheDirectory("seed-session");
    const provider = createJustBashProvider();

    await provider.prepare({
      appRoot,
      seedFiles: [],
    });

    const { handle: initialHandle, state: initialState } = await provider.start({
      appRoot,
      sandboxName: "session-seeded-later",
    });
    await initialHandle.onRuntimeShutdown();

    await provider.prepare({
      appRoot,
      seedFiles: [
        {
          content: "# Weather skill\n",
          path: "/workspace/skills/weather.md",
        },
      ],
    });

    await expect(
      provider.openSession({
        existing: initialState,
        appRoot,
        sandboxName: "session-seeded-later",
      }),
    ).rejects.toThrow("session state is incompatible");
  });
});
