import { existsSync } from "node:fs";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import {
  createMicrosandboxSandboxBackend,
  pruneMicrosandboxTemplates,
} from "#execution/sandbox/bindings/microsandbox.js";
import { isMicrosandboxPlatformSupported } from "#execution/sandbox/bindings/microsandbox-platform.js";

// Microsandbox is unsupported on Windows (native bindings ship for
// macOS Apple Silicon and glibc Linux only), so every suite in this
// file stays off win32. The real-VM suites are additionally opt-in:
// they install the microsandbox runtime, pull OCI images, and boot
// VMs. Run with: EVE_RUN_MICROSANDBOX_SCENARIOS=1
const onWindows = process.platform === "win32";
const runMicrosandboxVmScenarios =
  !onWindows &&
  process.env.EVE_RUN_MICROSANDBOX_SCENARIOS === "1" &&
  isMicrosandboxPlatformSupported();

const createScratchDirectory = useTemporaryDirectories();

async function createTemporaryCacheDirectory(label: string): Promise<string> {
  // The backend derives its cache directory from
  // `runtimeContext.appRoot` via `resolveSandboxCacheDirectory`, so the
  // helper returns a temporary appRoot rather than a cache directory
  // directly.
  return await createScratchDirectory(`eve-microsandbox-${label}-`);
}

async function createPrewarmedHandle(input: {
  readonly appRoot: string;
  readonly sessionKey: string;
  readonly templateKey: string;
}) {
  const backend = createMicrosandboxSandboxBackend();
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

describe.runIf(runMicrosandboxVmScenarios)("microsandbox sandbox file API", () => {
  it("writes a file via the public session and reads it back", async () => {
    const appRoot = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedHandle({
      appRoot,
      sessionKey: "session-write-read",
      templateKey: "tpl-write-read",
    });

    await handle.session.writeTextFile({ content: "hello world", path: "note.txt" });
    const content = await handle.session.readTextFile({ path: "note.txt" });

    expect(content).toBe("hello world");
  });

  it("passes env vars to a command run via the public session", async () => {
    const appRoot = await createTemporaryCacheDirectory("run-env");
    const handle = await createPrewarmedHandle({
      appRoot,
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
    const appRoot = await createTemporaryCacheDirectory("spawn-env");
    const handle = await createPrewarmedHandle({
      appRoot,
      sessionKey: "session-spawn-env",
      templateKey: "tpl-spawn-env",
    });

    const spawned = await handle.session.spawn({
      command: 'echo "$DEPLOY_ENV"',
      env: { DEPLOY_ENV: "production" },
    });
    const stdout = await collectStream(spawned.stdout);
    const { exitCode } = await spawned.wait();

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("production");
  });

  it("applies setNetworkPolicy by restarting the microsandbox VM", async () => {
    const appRoot = await createTemporaryCacheDirectory("network-policy");
    const handle = await createPrewarmedHandle({
      appRoot,
      sessionKey: "session-network-policy",
      templateKey: "tpl-network-policy",
    });

    await expect(handle.session.setNetworkPolicy("deny-all")).resolves.toBeUndefined();
  });

  it("readFile returns null for a missing file", async () => {
    const appRoot = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedHandle({
      appRoot,
      sessionKey: "session-missing",
      templateKey: "tpl-missing",
    });

    const content = await handle.session.readTextFile({ path: "does-not-exist.txt" });

    expect(content).toBeNull();
  });

  it("removePath deletes a recursive directory tree", async () => {
    const appRoot = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedHandle({
      appRoot,
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
    const backend = createMicrosandboxSandboxBackend();

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

    expect(state.backendName).toBe("microsandbox");
    expect(state.metadata).toMatchObject({
      optionsHash: expect.any(String),
      sandboxName: expect.any(String),
      version: 2,
    });

    const reconnectedHandle = await backend.create({
      existingMetadata: state.metadata,
      runtimeContext: { appRoot },
      sessionKey: "session-reconnect",
      templateKey: "tpl-reconnect",
    });
    const content = await reconnectedHandle.session.readTextFile({ path: "persisted.txt" });

    expect(content).toBe("survives reconnect");
  });

  it("preserves Buffer bytes written through the public session", async () => {
    const appRoot = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedHandle({
      appRoot,
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

  it("reports a fresh build on first prewarm and a reuse on the second", async () => {
    const appRoot = await createTemporaryCacheDirectory("reuse-report");
    const backend = createMicrosandboxSandboxBackend();

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
    const handle = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: "session-reuse-report",
      templateKey: "tpl-reuse-report",
    });
    await expect(
      handle.session.readTextFile({ path: "/workspace/skills/weather.md" }),
    ).resolves.toBe("# Weather skill\n");
  });
});

// Template pruning operates on the on-disk metadata cache and only
// touches the microsandbox runtime when it is already installed, so it
// runs without the VM gate (still not on Windows).
describe.skipIf(onWindows)("pruneMicrosandboxTemplates", () => {
  it("prunes stale cached templates while preserving retained and recent templates", async () => {
    const appRoot = await createTemporaryCacheDirectory("template-prune");
    const templatesRoot = join(appRoot, ".eve", "sandbox-cache", "microsandbox", "templates");
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

    await pruneMicrosandboxTemplates({
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
});
