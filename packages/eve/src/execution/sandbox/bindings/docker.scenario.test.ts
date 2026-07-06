import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createDockerCli, DockerUnavailableError } from "#execution/sandbox/bindings/docker-cli.js";
import { createDockerSandboxBackend } from "#execution/sandbox/bindings/docker.js";
import {
  createDockerSandboxOptionsHash,
  DEFAULT_DOCKER_SANDBOX_IMAGE,
  resolveDockerSandboxOptions,
} from "#execution/sandbox/bindings/docker-options.js";
import { dockerTemplateImageReference } from "#execution/sandbox/bindings/docker-templates.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

// Real-daemon scenarios are opt-in: they pull images and create
// containers, so CI and dev machines without Docker stay green.
// Run with: EVE_RUN_DOCKER_SANDBOX_SCENARIOS=1
const runDockerScenarios = process.env.EVE_RUN_DOCKER_SANDBOX_SCENARIOS === "1";

// Default to the same image users get while allowing opt-in scenario
// runs to pin a local or mirrored image.
const TEST_IMAGE = process.env.EVE_DOCKER_SANDBOX_TEST_IMAGE ?? DEFAULT_DOCKER_SANDBOX_IMAGE;

const createScratchDirectory = useTemporaryDirectories();

describe("docker CLI resolution", () => {
  it("fails with an actionable error when the docker executable is missing", async () => {
    vi.stubEnv("EVE_DOCKER_PATH", "/nonexistent/docker-binary");
    try {
      const appRoot = await createScratchDirectory("eve-docker-missing-");
      const engine = createDockerSandboxBackend();

      await expect(
        engine.prewarm({ runtimeContext: { appRoot }, seedFiles: [], templateKey: "tpl-x" }),
      ).rejects.toThrow(DockerUnavailableError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe.runIf(runDockerScenarios)("docker sandbox engine against a real daemon", () => {
  const runId = randomUUID().slice(0, 8);
  const templateKey = `eve-sbx-tpl-test-${runId}`;
  const templateImageReference = dockerTemplateImageReference({
    optionsHash: createDockerSandboxOptionsHash(resolveDockerSandboxOptions({ image: TEST_IMAGE })),
    templateKey,
  });
  const sessionKeys: string[] = [];
  const cleanupCli = createDockerCli();

  function nextSessionKey(label: string): string {
    const key = `eve-sbx-ses-test-${runId}-${label}`;
    sessionKeys.push(key);
    return key;
  }

  function createEngine() {
    return createDockerSandboxBackend({ createOptions: { image: TEST_IMAGE } });
  }

  afterAll(async () => {
    for (const sessionKey of sessionKeys) {
      await cleanupCli.run(["rm", "-f", sessionKey]);
    }
    await cleanupCli.run(["rmi", "-f", templateImageReference]);
  }, 60_000);

  it(
    "prewarms a template with seed files and opens a session from it",
    async () => {
      const appRoot = await createScratchDirectory("eve-docker-scenario-");
      const engine = createEngine();

      const first = await engine.prewarm({
        runtimeContext: { appRoot },
        seedFiles: [{ content: "# Weather skill\n", path: "/workspace/skills/weather.md" }],
        templateKey,
      });
      expect(first).toEqual({ reused: false });

      const second = await engine.prewarm({
        runtimeContext: { appRoot },
        seedFiles: [{ content: "# Weather skill\n", path: "/workspace/skills/weather.md" }],
        templateKey,
      });
      expect(second).toEqual({ reused: true });

      const handle = await engine.create({
        runtimeContext: { appRoot },
        sessionKey: nextSessionKey("seeded"),
        templateKey,
      });

      const result = await handle.session.run({
        command: "cat /workspace/skills/weather.md",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("# Weather skill\n");
    },
    5 * 60_000,
  );

  it(
    "runs commands with env vars and streams spawned output",
    async () => {
      const appRoot = await createScratchDirectory("eve-docker-scenario-");
      const engine = createEngine();
      const handle = await engine.create({
        runtimeContext: { appRoot },
        sessionKey: nextSessionKey("env"),
        templateKey,
      });

      const result = await handle.session.run({
        command: 'echo "$DEPLOY_ENV"',
        env: { DEPLOY_ENV: "staging" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("staging");

      const spawned = await handle.session.spawn({ command: "printf out; printf err >&2" });
      const [stdout, stderr, waited] = await Promise.all([
        collectStream(spawned.stdout),
        collectStream(spawned.stderr),
        spawned.wait(),
      ]);
      expect(waited.exitCode).toBe(0);
      expect(stdout).toBe("out");
      expect(stderr).toBe("err");
    },
    5 * 60_000,
  );

  it(
    "kill() terminates the spawned process tree inside the container",
    async () => {
      const appRoot = await createScratchDirectory("eve-docker-scenario-");
      const engine = createEngine();
      const handle = await engine.create({
        runtimeContext: { appRoot },
        sessionKey: nextSessionKey("kill-tree"),
        templateKey,
      });

      // Counts container processes whose cmdline matches the sentinel
      // sleeps. The patterns are assembled at runtime so the counting
      // command's own cmdline never matches itself.
      const countSurvivors = [
        'pat_a="sleep 3"; pat_a="${pat_a}27"',
        'pat_b="sleep 3"; pat_b="${pat_b}13"',
        "count=0",
        "for f in /proc/[0-9]*/cmdline; do",
        '  c="$(tr "\\0" " " < "$f" 2>/dev/null)"',
        '  case "$c" in *"$pat_a"*|*"$pat_b"*) count=$((count+1)) ;; esac',
        "done",
        'echo "$count"',
      ].join("\n");

      // A foreground child plus a backgrounded one exercises the
      // recursive tree kill beyond the immediate wrapper pid.
      const spawned = await handle.session.spawn({ command: "sleep 327 & sleep 313" });

      let running = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const counted = await handle.session.run({ command: countSurvivors });
        running = Number(counted.stdout.trim());
        if (running >= 2) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(running).toBeGreaterThanOrEqual(2);

      await spawned.kill();
      await Promise.resolve(spawned.wait()).catch(() => {});

      const survivors = await handle.session.run({ command: countSurvivors });
      expect(survivors.exitCode).toBe(0);
      expect(survivors.stdout.trim()).toBe("0");
    },
    5 * 60_000,
  );

  it(
    "round-trips files, preserves binary bytes, and removes paths",
    async () => {
      const appRoot = await createScratchDirectory("eve-docker-scenario-");
      const engine = createEngine();
      const handle = await engine.create({
        runtimeContext: { appRoot },
        sessionKey: nextSessionKey("files"),
        templateKey,
      });

      await handle.session.writeTextFile({ content: "hello", path: "deep/nested/note.txt" });
      await expect(
        handle.session.readTextFile({ path: "/workspace/deep/nested/note.txt" }),
      ).resolves.toBe("hello");

      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
      await handle.session.writeBinaryFile({ content: bytes, path: "assets/fixture.bin" });
      const sized = await handle.session.run({ command: "wc -c < assets/fixture.bin" });
      expect(Number(sized.stdout.trim())).toBe(bytes.length);
      const readBack = await handle.session.readBinaryFile({ path: "assets/fixture.bin" });
      expect(readBack === null ? null : Buffer.from(readBack).equals(bytes)).toBe(true);

      await expect(handle.session.readTextFile({ path: "missing.txt" })).resolves.toBeNull();

      await handle.session.removePath({ force: true, path: "deep", recursive: true });
      await expect(
        handle.session.readTextFile({ path: "deep/nested/note.txt" }),
      ).resolves.toBeNull();
    },
    5 * 60_000,
  );

  it(
    "flips a deny-all-created session to allow-all and back",
    async () => {
      const appRoot = await createScratchDirectory("eve-docker-scenario-");
      const engine = createDockerSandboxBackend({
        createOptions: { image: TEST_IMAGE, networkPolicy: "deny-all" },
      });
      // Create from the suite's prewarmed template: bash is already
      // baked in there, which a `--network none` container could not
      // install on the fly.
      const handle = await engine.create({
        runtimeContext: { appRoot },
        sessionKey: nextSessionKey("network-flip"),
        templateKey,
      });

      // `--network none` containers have no interfaces beyond loopback.
      const denied = await handle.session.run({ command: "ip route 2>/dev/null | wc -l" });
      expect(denied.stdout.trim()).toBe("0");

      await handle.session.setNetworkPolicy("allow-all");
      const allowed = await handle.session.run({ command: "ip route 2>/dev/null | wc -l" });
      expect(Number(allowed.stdout.trim())).toBeGreaterThan(0);

      await handle.session.setNetworkPolicy("deny-all");
      const deniedAgain = await handle.session.run({ command: "ip route 2>/dev/null | wc -l" });
      expect(deniedAgain.stdout.trim()).toBe("0");
    },
    5 * 60_000,
  );

  it(
    "persists session state across shutdown and reattach",
    async () => {
      const appRoot = await createScratchDirectory("eve-docker-scenario-");
      const engine = createEngine();
      const sessionKey = nextSessionKey("reconnect");

      const firstHandle = await engine.create({
        runtimeContext: { appRoot },
        sessionKey,
        templateKey,
      });
      await firstHandle.session.writeTextFile({
        content: "survives reconnect",
        path: "persisted.txt",
      });
      const state = await firstHandle.captureState();
      expect(state.metadata).toEqual({ containerName: sessionKey });
      // Server shutdown stops the container; reattach must restart it
      // transparently.
      await firstHandle.shutdown();

      const reconnected = await engine.create({
        existingMetadata: state.metadata,
        runtimeContext: { appRoot },
        sessionKey,
        templateKey,
      });
      await expect(reconnected.session.readTextFile({ path: "persisted.txt" })).resolves.toBe(
        "survives reconnect",
      );
    },
    5 * 60_000,
  );
});

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
