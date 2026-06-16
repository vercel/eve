import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import {
  createJustBashSandboxBackend,
  pruneJustBashSandboxTemplates,
} from "#execution/sandbox/bindings/just-bash.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";

const createScratchDirectory = useTemporaryDirectories();

// The whole file exercises the opt-in just-bash backend; the workspace
// devDependency provides the `just-bash` install that applications opt
// into explicitly.
function createJustBashBackend(): SandboxBackend {
  return createJustBashSandboxBackend();
}

async function createTemporaryCacheDirectory(label: string): Promise<string> {
  // The local backend derives its cache directory from
  // `runtimeContext.appRoot` via `resolveSandboxCacheDirectory`, so the
  // helper returns a temporary appRoot rather than a cache directory
  // directly.
  return await createScratchDirectory(`eve-local-sandbox-${label}-`);
}

async function createPrewarmedLocalHandle(input: {
  readonly appRoot: string;
  readonly sessionKey: string;
  readonly templateKey: string;
}) {
  const backend = createJustBashBackend();
  await backend.prewarm({
    runtimeContext: { appRoot: input.appRoot },
    seedFiles: [],
    templateKey: input.templateKey,
  });
  return await backend.create({
    runtimeContext: { appRoot: input.appRoot },
    sessionKey: input.sessionKey,
    templateKey: input.templateKey,
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
  it("writes a file via the public session and reads it back", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sessionKey: "session-write-read",
      templateKey: "tpl-write-read",
    });

    await handle.session.writeTextFile({ content: "hello world", path: "note.txt" });
    const content = await handle.session.readTextFile({ path: "note.txt" });

    expect(content).toBe("hello world");
  });

  it("passes env vars to a command run via the public session", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("run-env");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sessionKey: "session-run-env",
      templateKey: "tpl-run-env",
    });

    const result = await handle.session.run({
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
      sessionKey: "session-spawn-env",
      templateKey: "tpl-spawn-env",
    });

    const process = await handle.session.spawn({
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
      sessionKey: "session-network-policy",
      templateKey: "tpl-network-policy",
    });

    await expect(handle.session.setNetworkPolicy("deny-all")).rejects.toThrow(
      "not supported on the just-bash sandbox backend",
    );
  });

  it("readFile returns null for a missing file", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sessionKey: "session-missing",
      templateKey: "tpl-missing",
    });

    const content = await handle.session.readTextFile({ path: "does-not-exist.txt" });

    expect(content).toBeNull();
  });

  it("writeFile creates parent directories recursively", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sessionKey: "session-mkdir",
      templateKey: "tpl-mkdir",
    });

    await handle.session.writeTextFile({
      content: "nested content",
      path: "deep/nested/dir/file.txt",
    });
    const content = await handle.session.readTextFile({ path: "deep/nested/dir/file.txt" });

    expect(content).toBe("nested content");
  });

  it("writeFile overwrites an existing file", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sessionKey: "session-overwrite",
      templateKey: "tpl-overwrite",
    });

    await handle.session.writeTextFile({ content: "original", path: "file.txt" });
    await handle.session.writeTextFile({ content: "replaced", path: "file.txt" });
    const content = await handle.session.readTextFile({ path: "file.txt" });

    expect(content).toBe("replaced");
  });

  it("removePath deletes a recursive directory tree", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sessionKey: "session-remove",
      templateKey: "tpl-remove",
    });

    await handle.session.writeTextFile({
      content: "dynamic skill",
      path: "skills/tenant/SKILL.md",
    });
    await handle.session.writeTextFile({
      content: "policy",
      path: "skills/tenant/references/policy.md",
    });
    await handle.session.removePath({ force: true, path: "skills/tenant", recursive: true });

    await expect(
      handle.session.readTextFile({ path: "skills/tenant/SKILL.md" }),
    ).resolves.toBeNull();
    await expect(
      handle.session.readTextFile({ path: "skills/tenant/references/policy.md" }),
    ).resolves.toBeNull();
  });

  it("preserves files across capture and reconnect", async () => {
    const appRoot = await createTemporaryCacheDirectory("file-api");
    const backend = createJustBashBackend();

    await backend.prewarm({
      runtimeContext: { appRoot },
      seedFiles: [],
      templateKey: "tpl-reconnect",
    });

    const firstHandle = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: "session-reconnect",
      templateKey: "tpl-reconnect",
    });
    await firstHandle.session.writeTextFile({
      content: "survives reconnect",
      path: "persisted.txt",
    });

    const state = await firstHandle.captureState();

    expect(state.metadata).toEqual({
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

    const reconnectedHandle = await backend.create({
      existingMetadata: state.metadata,
      runtimeContext: { appRoot },
      sessionKey: "session-reconnect",
      templateKey: "tpl-reconnect",
    });
    const content = await reconnectedHandle.session.readTextFile({ path: "persisted.txt" });

    expect(content).toBe("survives reconnect");
  });

  it("supports readFile with line range options", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sessionKey: "session-line-range",
      templateKey: "tpl-line-range",
    });

    await handle.session.writeTextFile({
      content: "alpha\nbeta\ngamma\ndelta\n",
      path: "lines.txt",
    });
    const range = await handle.session.readTextFile({
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
      sessionKey: "session-relative",
      templateKey: "tpl-relative",
    });

    await handle.session.writeTextFile({ content: "relative write", path: "rel.txt" });
    const content = await handle.session.readTextFile({ path: "/workspace/rel.txt" });

    expect(content).toBe("relative write");
  });

  it("preserves Buffer bytes written through the public session", async () => {
    const cacheDirectory = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedLocalHandle({
      appRoot: cacheDirectory,
      sessionKey: "session-buffer",
      templateKey: "tpl-buffer",
    });

    // A PNG header plus a handful of non-UTF-8 bytes. Reading this
    // back as UTF-8 text would throw, so the roundtrip check uses the
    // `wc -c` command to confirm the on-disk byte length matches.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    await handle.session.writeBinaryFile({ content: bytes, path: "assets/fixture.bin" });

    const result = await handle.session.run({ command: "wc -c < assets/fixture.bin" });
    expect(result.exitCode).toBe(0);
    expect(Number(result.stdout.trim())).toBe(bytes.length);
  });
});

describe("createLocalSandboxBackend with the just-bash engine", () => {
  it("exposes a distinct stable backend name", () => {
    const backend = createJustBashBackend();
    expect(backend.name).toBe("just-bash");
  });

  it("creates a fresh session when no template key is requested", async () => {
    const appRoot = await createTemporaryCacheDirectory("fresh-session");
    const backend = createJustBashBackend();

    const handle = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: "session-without-template",
      templateKey: null,
    });
    const result = await handle.session.run({
      command: "find /workspace -maxdepth 2 -type f | sort",
    });

    expect(result.stdout.trim()).toBe("");
  });

  it("reports a fresh build on first prewarm and a reuse on the second", async () => {
    const appRoot = await createTemporaryCacheDirectory("reuse-report");
    const backend = createJustBashBackend();

    const first = await backend.prewarm({
      runtimeContext: { appRoot },
      seedFiles: [{ content: "# Weather skill\n", path: "/workspace/skills/weather.md" }],
      templateKey: "tpl-reuse-report",
    });
    const second = await backend.prewarm({
      runtimeContext: { appRoot },
      seedFiles: [{ content: "# Weather skill\n", path: "/workspace/skills/weather.md" }],
      templateKey: "tpl-reuse-report",
    });

    expect(first).toEqual({ reused: false });
    expect(second).toEqual({ reused: true });
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
    const backend = createJustBashBackend();
    const templateRoot = join(appRoot, ".eve", "sandbox-cache", "just-bash", "templates", "active");
    const oldTime = new Date(1_000);
    const now = Date.now();

    await backend.prewarm({
      runtimeContext: { appRoot },
      seedFiles: [],
      templateKey: "active",
    });
    await utimes(templateRoot, oldTime, oldTime);

    await expect(
      backend.prewarm({
        runtimeContext: { appRoot },
        seedFiles: [],
        templateKey: "active",
      }),
    ).resolves.toEqual({ reused: true });

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
    const backend = createJustBashBackend();

    await backend.prewarm({
      runtimeContext: { appRoot },
      seedFiles: [
        {
          content: "# Weather skill\n",
          path: "/workspace/skills/weather.md",
        },
      ],
      templateKey: "template-seeded-later",
    });

    const seededHandle = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: "session-from-repaired-template",
      templateKey: "template-seeded-later",
    });
    const result = await seededHandle.session.run({
      command: "find /workspace -maxdepth 3 -type f | sort",
    });

    expect(result.stdout.trim().split("\n")).toEqual(["/workspace/skills/weather.md"]);
  });

  it("does not repair an existing session directory with later seed files", async () => {
    const appRoot = await createTemporaryCacheDirectory("seed-session");
    const backend = createJustBashBackend();

    await backend.prewarm({
      runtimeContext: { appRoot },
      seedFiles: [],
      templateKey: "template-seeded-later-session",
    });

    const initialHandle = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: "session-seeded-later",
      templateKey: "template-seeded-later-session",
    });
    const initialState = await initialHandle.captureState();

    await initialHandle.dispose();

    await backend.prewarm({
      runtimeContext: { appRoot },
      seedFiles: [
        {
          content: "# Weather skill\n",
          path: "/workspace/skills/weather.md",
        },
      ],
      templateKey: "template-seeded-later-session-next",
    });

    const seededHandle = await backend.create({
      existingMetadata: initialState.metadata,
      runtimeContext: { appRoot },
      sessionKey: "session-seeded-later",
      templateKey: "template-seeded-later-session-next",
    });
    const result = await seededHandle.session.run({
      command: "find /workspace -maxdepth 3 -type f | sort",
    });

    expect(result.stdout.trim()).toBe("");
  });
});
