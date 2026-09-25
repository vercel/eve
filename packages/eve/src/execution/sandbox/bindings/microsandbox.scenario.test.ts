import { existsSync } from "node:fs";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import {
  createMicrosandboxSandboxProvider,
  pruneMicrosandboxTemplates,
} from "#execution/sandbox/bindings/microsandbox.js";
import { isMicrosandboxPlatformSupported } from "#execution/sandbox/bindings/microsandbox-platform.js";
import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";

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

function createProvider() {
  return createSandboxProviderHarness(createMicrosandboxSandboxProvider(), undefined);
}

async function createTemporaryCacheDirectory(label: string): Promise<string> {
  // The provider derives its cache directory from
  // `appRoot` via `resolveSandboxCacheDirectory`, so the
  // helper returns a temporary appRoot rather than a cache directory
  // directly.
  return await createScratchDirectory(`eve-microsandbox-${label}-`);
}

async function createPrewarmedHandle(input: {
  readonly appRoot: string;
  readonly sandboxName: string;
}) {
  const provider = createProvider();
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

describe.runIf(runMicrosandboxVmScenarios)("microsandbox sandbox file API", () => {
  it("prewarms from a colocated Dockerfile", async () => {
    const appRoot = await createTemporaryCacheDirectory("dockerfile");
    const agentRoot = join(appRoot, "agent");
    const sandboxRoot = join(agentRoot, "sandbox");
    await mkdir(sandboxRoot, { recursive: true });
    await writeFile(
      join(sandboxRoot, "Dockerfile"),
      [
        "FROM ubuntu:24.04",
        "RUN apt-get update && apt-get install -y bash sudo",
        "RUN printf dockerfile-ready > /dockerfile-marker",
        "",
      ].join("\n"),
    );
    const resourcesPath = join(appRoot, "compiled-resources");
    await mkdir(join(resourcesPath, "workspace"), { recursive: true });
    await writeFile(join(resourcesPath, "workspace", "seed.txt"), "immutable seed");
    const provider = createProvider();
    await provider.prepare({
      resourcesPath,
      appRoot,
      seedFiles: [],
    });
    const handle = await provider.openSession({
      appRoot,
      sandboxName: "session-dockerfile",
    });

    const result = await handle.sandbox.run({
      command: [
        "cat /dockerfile-marker",
        "cat /workspace/seed.txt",
        "! sh -c 'printf bad > /eve/resources/workspace/seed.txt' 2>/dev/null",
        "printf changed > /workspace/seed.txt",
      ].join(" && "),
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "dockerfile-readyimmutable seed" });
  });

  it("writes a file via the public session and reads it back", async () => {
    const appRoot = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedHandle({
      appRoot,
      sandboxName: "session-write-read",
    });

    await handle.sandbox.writeTextFile({ content: "hello world", path: "note.txt" });
    const content = await handle.sandbox.readTextFile({ path: "note.txt" });

    expect(content).toBe("hello world");
  });

  it("passes env vars to a command run via the public session", async () => {
    const appRoot = await createTemporaryCacheDirectory("run-env");
    const handle = await createPrewarmedHandle({
      appRoot,
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
    const appRoot = await createTemporaryCacheDirectory("spawn-env");
    const handle = await createPrewarmedHandle({
      appRoot,
      sandboxName: "session-spawn-env",
    });

    const spawned = await handle.sandbox.spawn({
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
      sandboxName: "session-network-policy",
    });

    await expect(handle.sandbox.setNetworkPolicy("deny-all")).resolves.toBeUndefined();
  });

  it("readFile returns null for a missing file", async () => {
    const appRoot = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedHandle({
      appRoot,
      sandboxName: "session-missing",
    });

    const content = await handle.sandbox.readTextFile({ path: "does-not-exist.txt" });

    expect(content).toBeNull();
  });

  it("removePath deletes a recursive directory tree", async () => {
    const appRoot = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedHandle({
      appRoot,
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
    const provider = createProvider();

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

    expect(state).toMatchObject({
      optionsHash: expect.any(String),
      sandboxName: expect.any(String),
      version: 2,
    });

    const reconnectedHandle = await provider.openSession({
      existing: state,
      appRoot,
      sandboxName: "session-reconnect",
    });
    const content = await reconnectedHandle.sandbox.readTextFile({ path: "persisted.txt" });

    expect(content).toBe("survives reconnect");
  });

  it("preserves Buffer bytes written through the public session", async () => {
    const appRoot = await createTemporaryCacheDirectory("file-api");
    const handle = await createPrewarmedHandle({
      appRoot,
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

  it("reports a fresh build on first prewarm and a reuse on the second", async () => {
    const appRoot = await createTemporaryCacheDirectory("reuse-report");
    const provider = createProvider();

    const first = await provider.prepare({
      appRoot,
      seedFiles: [{ content: "# Weather skill\n", path: "/workspace/skills/weather.md" }],
    });
    const second = await provider.prepare({
      appRoot,
      seedFiles: [{ content: "# Weather skill\n", path: "/workspace/skills/weather.md" }],
    });

    expect(second).toEqual(first);
    const handle = await provider.openSession({
      appRoot,
      sandboxName: "session-reuse-report",
    });
    await expect(
      handle.sandbox.readTextFile({ path: "/workspace/skills/weather.md" }),
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
