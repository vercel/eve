import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DockerDaemonUnavailableError,
  type DockerCli,
  type DockerCommandResult,
  type DockerProcess,
} from "#execution/sandbox/bindings/docker-cli.js";
import {
  createDockerSandboxBackend,
  DOCKER_TEMPLATE_IMAGE_REPOSITORY,
  pruneDockerSandboxTemplates,
} from "#execution/sandbox/bindings/docker.js";
import { EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV } from "#execution/sandbox/development-run.js";
import {
  createDockerSandboxOptionsHash,
  DEFAULT_DOCKER_SANDBOX_IMAGE,
  resolveDockerSandboxOptions,
} from "#execution/sandbox/bindings/docker-options.js";
import { dockerTemplateImageReference } from "#execution/sandbox/bindings/docker-templates.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";
import { SandboxTemplateNotProvisionedError } from "#public/definitions/sandbox-backend.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { bufferToStream } from "#execution/sandbox/stream-utils.js";

const createScratchDirectory = useTemporaryDirectories();

type FakeResponse = Partial<DockerCommandResult> & {
  readonly streamStdout?: string;
};

interface FakeDockerCall {
  readonly args: readonly string[];
  readonly stdin?: Buffer;
}

function createFakeDockerCli(
  respond: (args: readonly string[]) => FakeResponse | undefined = () => undefined,
): { calls: FakeDockerCall[]; cli: DockerCli; killedStreams: (readonly string[])[] } {
  const calls: FakeDockerCall[] = [];
  const killedStreams: (readonly string[])[] = [];

  function resolve(args: readonly string[]): DockerCommandResult {
    const partial = respond(args) ?? {};
    const stdout = partial.stdout ?? "";
    return {
      exitCode: partial.exitCode ?? 0,
      stderr: partial.stderr ?? "",
      stdout,
      stdoutBytes: partial.stdoutBytes ?? Buffer.from(stdout, "utf8"),
    };
  }

  return {
    calls,
    killedStreams,
    cli: {
      async run(args, options) {
        calls.push({
          args: [...args],
          stdin: options?.stdin === undefined ? undefined : Buffer.from(options.stdin),
        });
        return resolve(args);
      },
      stream(args): DockerProcess {
        calls.push({ args: [...args] });
        const partial = respond(args) ?? {};
        return {
          stdout: bufferToStream(Buffer.from(partial.streamStdout ?? "", "utf8")),
          stderr: bufferToStream(Buffer.alloc(0)),
          async wait() {
            return { exitCode: partial.exitCode ?? 0 };
          },
          async kill() {
            killedStreams.push([...args]);
          },
        };
      },
    },
  };
}

function createEngine(input: {
  readonly cli: DockerCli;
  readonly options?: DockerSandboxCreateOptions;
}) {
  return createDockerSandboxBackend({
    createOptions: input.options,
    dockerCli: input.cli,
  });
}

function findCall(
  calls: readonly FakeDockerCall[],
  predicate: (args: readonly string[]) => boolean,
): FakeDockerCall | undefined {
  return calls.find((call) => predicate(call.args));
}

function isImageInspect(args: readonly string[], reference: string): boolean {
  return args[0] === "image" && args[1] === "inspect" && args.at(-1) === reference;
}

function isContainerInspect(args: readonly string[]): boolean {
  return args[0] === "container" && args[1] === "inspect";
}

const TEMPLATE_KEY = "eve-sbx-tpl-local-abc123";
const DEFAULT_DOCKER_OPTIONS_HASH = createDockerSandboxOptionsHash(resolveDockerSandboxOptions());
const TEMPLATE_IMAGE = dockerTemplateImageReference({
  optionsHash: DEFAULT_DOCKER_OPTIONS_HASH,
  templateKey: TEMPLATE_KEY,
});
const SESSION_KEY = "eve-sbx-ses-local-session-1";

function defaultDockerTemplateImageTag(templateKey: string): string {
  return dockerTemplateImageReference({
    optionsHash: DEFAULT_DOCKER_OPTIONS_HASH,
    templateKey,
  }).slice(`${DOCKER_TEMPLATE_IMAGE_REPOSITORY}:`.length);
}

describe("createDockerSandboxBackend prewarm", () => {
  it("reuses an existing template image without building", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { calls, cli } = createFakeDockerCli((args) => {
      if (isImageInspect(args, TEMPLATE_IMAGE)) {
        return { exitCode: 0, stdout: "sha256:abc\n" };
      }
      return undefined;
    });

    const result = await createEngine({ cli }).prewarm({
      runtimeContext: { appRoot },
      seedFiles: [],
      templateKey: TEMPLATE_KEY,
    });

    expect(result).toEqual({ reused: true });
    expect(findCall(calls, (args) => args[0] === "run")).toBeUndefined();
    expect(findCall(calls, (args) => args[0] === "commit")).toBeUndefined();
    // The reuse touches the per-app marker so pruning sees the template
    // as active.
    await expect(
      readFile(
        join(
          appRoot,
          ".eve",
          "sandbox-cache",
          "docker",
          "templates",
          defaultDockerTemplateImageTag(TEMPLATE_KEY),
        ),
        "utf8",
      ),
    ).resolves.toContain(TEMPLATE_IMAGE);
  });

  it("builds, seeds, commits, and cleans up when the template image is missing", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { calls, cli } = createFakeDockerCli((args) => {
      if (isImageInspect(args, TEMPLATE_IMAGE)) {
        return { exitCode: 1, stderr: "No such image" };
      }
      if (isImageInspect(args, DEFAULT_DOCKER_SANDBOX_IMAGE)) {
        return { exitCode: 1, stderr: "No such image" };
      }
      return undefined;
    });

    const result = await createEngine({ cli }).prewarm({
      runtimeContext: { appRoot },
      seedFiles: [{ content: "# Weather skill\n", path: "/workspace/skills/weather.md" }],
      templateKey: TEMPLATE_KEY,
    });

    expect(result).toEqual({ reused: false });

    const pull = findCall(calls, (args) => args[0] === "pull");
    expect(pull?.args).toEqual(["pull", DEFAULT_DOCKER_SANDBOX_IMAGE]);

    const run = findCall(calls, (args) => args[0] === "run");
    expect(run).toBeDefined();
    expect(run?.args).toContain("--entrypoint");
    expect(run?.args).toContain("/bin/sh");
    expect(run?.args).toContain(`eve.sandbox.role=template-build`);
    const buildContainerName = run?.args[run.args.indexOf("--name") + 1];
    expect(buildContainerName).toMatch(new RegExp(`^${TEMPLATE_KEY}-build-`));

    const baseSetup = findCall(
      calls,
      (args) =>
        args[0] === "exec" &&
        args[1] === "--user" &&
        args[2] === "root" &&
        args[4] === "/bin/sh" &&
        args[5] === "-c",
    );
    expect(baseSetup?.args[6]).toContain("mkdir -p /workspace");
    expect(baseSetup?.args[6]).toContain("command -v bash");
    expect(baseSetup?.args[6]).not.toContain("apt-get");
    expect(baseSetup?.args[6]).not.toContain("deb.nodesource.com/node_24.x");
    expect(baseSetup?.args[6]).not.toContain("python3");
    expect(baseSetup?.args[6]).not.toContain("ripgrep");

    const seedWrite = findCall(calls, (args) => args[0] === "exec" && args[1] === "-i");
    expect(seedWrite?.args.at(-1)).toContain("/workspace/skills/weather.md");
    expect(seedWrite?.stdin?.toString("utf8")).toBe("# Weather skill\n");

    const stop = findCall(calls, (args) => args[0] === "stop");
    expect(stop?.args).toEqual(["stop", "-t", "0", buildContainerName]);

    const commit = findCall(calls, (args) => args[0] === "commit");
    expect(commit?.args.at(-2)).toBe(buildContainerName);
    expect(commit?.args.at(-1)).toBe(TEMPLATE_IMAGE);

    const cleanup = findCall(calls, (args) => args[0] === "rm" && args[1] === "-f");
    expect(cleanup?.args.at(-1)).toBe(buildContainerName);
  });

  it("fails with an actionable error when the daemon is unreachable", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { cli } = createFakeDockerCli((args) => {
      if (args[0] === "version") {
        return { exitCode: 1, stderr: "Cannot connect to the Docker daemon" };
      }
      return undefined;
    });

    await expect(
      createEngine({ cli }).prewarm({
        runtimeContext: { appRoot },
        seedFiles: [],
        templateKey: TEMPLATE_KEY,
      }),
    ).rejects.toThrow(DockerDaemonUnavailableError);
  });
});

describe("createDockerSandboxBackend create", () => {
  it("throws SandboxTemplateNotProvisionedError when the template image is missing", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { cli } = createFakeDockerCli((args) => {
      if (isContainerInspect(args)) {
        return { exitCode: 1, stderr: "No such container" };
      }
      if (isImageInspect(args, TEMPLATE_IMAGE)) {
        return { exitCode: 1, stderr: "No such image" };
      }
      return undefined;
    });

    await expect(
      createEngine({ cli }).create({
        runtimeContext: { appRoot },
        sessionKey: SESSION_KEY,
        templateKey: TEMPLATE_KEY,
      }),
    ).rejects.toThrow(SandboxTemplateNotProvisionedError);
  });

  it("throws SandboxTemplateNotProvisionedError when a template-backed container fails to start", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { cli } = createFakeDockerCli((args) => {
      if (isContainerInspect(args)) {
        return { exitCode: 1, stderr: "No such container" };
      }
      if (isImageInspect(args, TEMPLATE_IMAGE)) {
        return { exitCode: 0, stdout: "sha256:abc\n" };
      }
      if (args[0] === "run") {
        return { exitCode: 1, stderr: "template-backed container failed to start" };
      }
      return undefined;
    });

    await expect(
      createEngine({ cli }).create({
        runtimeContext: { appRoot },
        sessionKey: SESSION_KEY,
        templateKey: TEMPLATE_KEY,
      }),
    ).rejects.toThrow(SandboxTemplateNotProvisionedError);
  });

  it("creates a session container from the template image with labels and tags", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const previousRunId = process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
    process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = "dev-run-test";
    const { calls, cli } = createFakeDockerCli((args) => {
      if (isContainerInspect(args)) {
        return { exitCode: 1, stderr: "No such container" };
      }
      return undefined;
    });

    try {
      const handle = await createEngine({ cli }).create({
        runtimeContext: { appRoot },
        sessionKey: SESSION_KEY,
        tags: { agent: "weather" },
        templateKey: TEMPLATE_KEY,
      });

      const run = findCall(calls, (args) => args[0] === "run");
      expect(run?.args).toContain(SESSION_KEY);
      expect(run?.args).toContain("eve.sandbox.role=session");
      expect(run?.args).toContain("eve.sandbox.tag.agent=weather");
      expect(run?.args).toContain("eve.sandbox.tag.devRunId=dev-run-test");
      expect(run?.args.at(-3)).toBe(TEMPLATE_IMAGE);

      // No base setup against template-backed sessions — the template
      // image already carries it.
      expect(
        findCall(calls, (args) => args[0] === "exec" && args.includes("/bin/sh")),
      ).toBeUndefined();

      await expect(handle.captureState()).resolves.toEqual({
        backendName: "docker",
        metadata: { containerName: SESSION_KEY },
        sessionKey: SESSION_KEY,
      });

      // Server shutdown stops the container; filesystem state survives
      // for the next `create` to restart from.
      await handle.shutdown();
      expect(findCall(calls, (args) => args[0] === "stop")?.args).toEqual([
        "stop",
        "-t",
        "0",
        SESSION_KEY,
      ]);
    } finally {
      if (previousRunId === undefined) {
        delete process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
      } else {
        process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = previousRunId;
      }
    }
  });

  it("restarts a stopped session container instead of creating a new one", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { calls, cli } = createFakeDockerCli((args) => {
      if (isContainerInspect(args)) {
        return { exitCode: 0, stdout: "false\n" };
      }
      return undefined;
    });

    await createEngine({ cli }).create({
      runtimeContext: { appRoot },
      sessionKey: SESSION_KEY,
      templateKey: TEMPLATE_KEY,
    });

    expect(findCall(calls, (args) => args[0] === "start")?.args).toEqual(["start", SESSION_KEY]);
    expect(findCall(calls, (args) => args[0] === "run")).toBeUndefined();
  });

  it("reattaches to a running container without docker run or start", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { calls, cli } = createFakeDockerCli((args) => {
      if (isContainerInspect(args)) {
        return { exitCode: 0, stdout: "true\n" };
      }
      return undefined;
    });

    await createEngine({ cli }).create({
      existingMetadata: { containerName: SESSION_KEY },
      runtimeContext: { appRoot },
      sessionKey: SESSION_KEY,
      templateKey: TEMPLATE_KEY,
    });

    expect(findCall(calls, (args) => args[0] === "start")).toBeUndefined();
    expect(findCall(calls, (args) => args[0] === "run")).toBeUndefined();
  });

  it("creates from the base image and applies base setup when no template exists", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { calls, cli } = createFakeDockerCli((args) => {
      if (isContainerInspect(args)) {
        return { exitCode: 1, stderr: "No such container" };
      }
      return undefined;
    });

    await createEngine({ cli }).create({
      runtimeContext: { appRoot },
      sessionKey: SESSION_KEY,
      templateKey: null,
    });

    const run = findCall(calls, (args) => args[0] === "run");
    expect(run?.args.at(-3)).toBe(DEFAULT_DOCKER_SANDBOX_IMAGE);
    expect(
      findCall(calls, (args) => args[0] === "exec" && args.includes("/bin/sh"))?.args.at(-1),
    ).toContain("mkdir -p /workspace");
  });
});

describe("docker session primitives", () => {
  async function createRunningSessionHandle(input: {
    readonly respond?: (args: readonly string[]) => FakeResponse | undefined;
    readonly options?: DockerSandboxCreateOptions;
  }) {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { calls, cli, killedStreams } = createFakeDockerCli((args) => {
      if (isContainerInspect(args) && args[3] === "{{.State.Running}}") {
        return { exitCode: 0, stdout: "true\n" };
      }
      return input.respond?.(args);
    });
    const handle = await createEngine({ cli, options: input.options }).create({
      runtimeContext: { appRoot },
      sessionKey: SESSION_KEY,
      templateKey: TEMPLATE_KEY,
    });
    return { calls, handle, killedStreams };
  }

  it("spawns commands through a pid-recording bash -lc wrapper with cwd and env", async () => {
    const { calls, handle } = await createRunningSessionHandle({
      respond: (args) => {
        if (args[0] === "exec" && args.includes("bash")) {
          return { exitCode: 0, streamStdout: "staging\n" };
        }
        return undefined;
      },
    });

    const result = await handle.session.run({
      command: 'echo "$DEPLOY_ENV"',
      env: { DEPLOY_ENV: "staging" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("staging");

    const exec = findCall(calls, (args) => args[0] === "exec" && args.includes("bash"));
    expect(exec?.args.slice(0, 8)).toEqual([
      "exec",
      "-w",
      "/workspace",
      "-e",
      "DEPLOY_ENV=staging",
      SESSION_KEY,
      "bash",
      "-c",
    ]);
    const wrapper = String(exec?.args.at(-1));
    // The wrapper records its pid for the in-container tree kill, runs
    // the original command under a login shell, and preserves its exit
    // code while cleaning up the pid file.
    expect(wrapper).toMatch(/^echo "\$\$" > '\/tmp\/\.eve-sbx-spawn-[0-9a-f-]+\.pid'; /);
    expect(wrapper).toContain(`bash -lc 'echo "$DEPLOY_ENV"'`);
    expect(wrapper).toMatch(/status=\$\?; rm -f '[^']+'; exit \$status$/);
  });

  it("kill() tree-kills inside the container before killing the docker exec client", async () => {
    const { calls, handle, killedStreams } = await createRunningSessionHandle({});

    const spawned = await handle.session.spawn({ command: "sleep 300" });
    const spawnExec = findCall(calls, (args) => args[0] === "exec" && args.includes("bash"));
    const wrapper = String(spawnExec?.args.at(-1));
    const pidFilePath = /'(\/tmp\/\.eve-sbx-spawn-[0-9a-f-]+\.pid)'/.exec(wrapper)?.[1];
    expect(pidFilePath).toBeDefined();

    await spawned.kill();

    const treeKill = findCall(calls, (args) => args.includes("eve-kill-tree"));
    expect(treeKill?.args.slice(0, 2)).toEqual(["exec", SESSION_KEY]);
    expect(treeKill?.args.at(-1)).toBe(pidFilePath);
    expect(String(treeKill?.args.at(-3))).toContain("kill_tree");
    // The local docker exec client is killed after the in-container
    // tree kill so the leaked-process window stays closed.
    expect(killedStreams).toHaveLength(1);
  });

  it("abort tree-kills the spawned process inside the container", async () => {
    const { calls, handle } = await createRunningSessionHandle({});
    const controller = new AbortController();

    await handle.session.spawn({ abortSignal: controller.signal, command: "sleep 300" });
    expect(findCall(calls, (args) => args.includes("eve-kill-tree"))).toBeUndefined();

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(findCall(calls, (args) => args.includes("eve-kill-tree"))).toBeDefined();
  });

  it("returns null from readFile for a missing path via the sentinel exit code", async () => {
    const { handle } = await createRunningSessionHandle({
      respond: (args) => {
        if (args[0] === "exec" && String(args.at(-1)).includes("exit 43")) {
          return { exitCode: 43 };
        }
        return undefined;
      },
    });

    await expect(handle.session.readTextFile({ path: "missing.txt" })).resolves.toBeNull();
  });

  it("round-trips binary bytes through writeFile and readFile", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    let written: Buffer | undefined;
    const { calls, handle } = await createRunningSessionHandle({
      respond: (args) => {
        if (args[0] === "exec" && String(args.at(-1)).includes("exec cat")) {
          return { exitCode: 0, stdoutBytes: written ?? Buffer.alloc(0) };
        }
        return undefined;
      },
    });

    await handle.session.writeBinaryFile({ content: bytes, path: "assets/fixture.bin" });
    const write = findCall(calls, (args) => args[0] === "exec" && args[1] === "-i");
    written = write?.stdin;
    expect(write?.args.at(-1)).toContain("mkdir -p '/workspace/assets'");
    expect(written?.equals(bytes)).toBe(true);

    const readBack = await handle.session.readBinaryFile({ path: "assets/fixture.bin" });
    expect(readBack === null ? null : Buffer.from(readBack).equals(bytes)).toBe(true);
  });

  it("maps removePath options onto rm flags", async () => {
    const { calls, handle } = await createRunningSessionHandle({});

    await handle.session.removePath({ force: true, path: "skills/tenant", recursive: true });

    const remove = findCall(calls, (args) => args[0] === "exec" && args.includes("rm"));
    expect(remove?.args).toEqual([
      "exec",
      SESSION_KEY,
      "rm",
      "-rf",
      "--",
      "/workspace/skills/tenant",
    ]);
  });

  it("applies deny-all by disconnecting every container network", async () => {
    const { calls, handle } = await createRunningSessionHandle({
      respond: (args) => {
        if (isContainerInspect(args) && args[3] === "{{json .NetworkSettings.Networks}}") {
          return { exitCode: 0, stdout: '{"bridge":{}}' };
        }
        return undefined;
      },
    });

    await handle.session.setNetworkPolicy("deny-all");

    expect(
      findCall(calls, (args) => args[0] === "network" && args[1] === "disconnect")?.args,
    ).toEqual(["network", "disconnect", "--force", "bridge", SESSION_KEY]);
  });

  it("applies allow-all to a deny-all-created container by detaching none before bridge", async () => {
    const { calls, handle } = await createRunningSessionHandle({
      respond: (args) => {
        if (isContainerInspect(args) && args[3] === "{{json .NetworkSettings.Networks}}") {
          // Containers created with `--network none` report the special
          // "none" network, which Docker refuses to combine with bridge.
          return { exitCode: 0, stdout: '{"none":{}}' };
        }
        return undefined;
      },
    });

    await handle.session.setNetworkPolicy("allow-all");

    const networkCalls = calls
      .filter((call) => call.args[0] === "network")
      .map((call) => call.args);
    expect(networkCalls).toEqual([
      ["network", "disconnect", "--force", "none", SESSION_KEY],
      ["network", "connect", "bridge", SESSION_KEY],
    ]);
  });

  it("rejects domain-level network policies with guidance toward the Vercel backend", async () => {
    const { handle } = await createRunningSessionHandle({});

    await expect(handle.session.setNetworkPolicy({ allow: { "*": [] } })).rejects.toThrow(
      /Vercel backend/,
    );
  });

  it("applies deny-all after base setup for template-less containers", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { calls, cli } = createFakeDockerCli((args) => {
      if (isContainerInspect(args) && args[3] === "{{.State.Running}}") {
        return { exitCode: 1, stderr: "No such container" };
      }
      if (isContainerInspect(args) && args[3] === "{{json .NetworkSettings.Networks}}") {
        return { exitCode: 0, stdout: '{"bridge":{}}' };
      }
      return undefined;
    });

    await createEngine({
      cli,
      options: { networkPolicy: "deny-all" },
    }).create({
      runtimeContext: { appRoot },
      sessionKey: SESSION_KEY,
      templateKey: null,
    });

    const run = findCall(calls, (args) => args[0] === "run");
    expect(run?.args).not.toContain("--network");

    const baseSetup = findCall(calls, (args) => args[0] === "exec" && args.includes("/bin/sh"));
    expect(baseSetup?.args.at(-1)).toContain("command -v bash");
    expect(baseSetup?.args.at(-1)).not.toContain("apt-get");
    expect(baseSetup?.args.at(-1)).not.toContain("deb.nodesource.com/node_24.x");
    expect(baseSetup?.args.at(-1)).not.toContain("python3");
    expect(baseSetup?.args.at(-1)).not.toContain("ripgrep");

    expect(
      findCall(calls, (args) => args[0] === "network" && args[1] === "disconnect")?.args,
    ).toEqual(["network", "disconnect", "--force", "bridge", SESSION_KEY]);
  });
});

describe("pruneDockerSandboxTemplates", () => {
  it("removes images for stale markers and keeps retained or recent ones", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const now = Date.now();

    // Seed three markers through real prewarm reuse so paths match the
    // engine's layout exactly.
    const { cli } = createFakeDockerCli((args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "sha256:abc\n" };
      }
      return undefined;
    });
    const engine = createEngine({ cli });
    for (const templateKey of ["tpl-stale", "tpl-retained", "tpl-recent"]) {
      await engine.prewarm({ runtimeContext: { appRoot }, seedFiles: [], templateKey });
    }

    const markersDirectory = join(appRoot, ".eve", "sandbox-cache", "docker", "templates");
    const { utimes } = await import("node:fs/promises");
    await utimes(
      join(markersDirectory, defaultDockerTemplateImageTag("tpl-stale")),
      new Date(now - 60_000),
      new Date(now - 60_000),
    );
    await utimes(
      join(markersDirectory, defaultDockerTemplateImageTag("tpl-retained")),
      new Date(now - 30_000),
      new Date(now - 30_000),
    );

    const { calls: pruneCalls, cli: pruneCli } = createFakeDockerCli();
    await pruneDockerSandboxTemplates({
      appRoot,
      dockerCli: pruneCli,
      now,
      recentWindowMs: 5_000,
      retainCount: 2,
    });

    expect(pruneCalls.map((call) => call.args)).toEqual([
      [
        "rmi",
        dockerTemplateImageReference({
          optionsHash: DEFAULT_DOCKER_OPTIONS_HASH,
          templateKey: "tpl-stale",
        }),
      ],
    ]);
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(markersDirectory)).resolves.toEqual(
      expect.arrayContaining([
        defaultDockerTemplateImageTag("tpl-recent"),
        defaultDockerTemplateImageTag("tpl-retained"),
      ]),
    );
  });

  it("keeps the marker when the image is still referenced by a container", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { cli } = createFakeDockerCli((args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "sha256:abc\n" };
      }
      return undefined;
    });
    await createEngine({ cli }).prewarm({
      runtimeContext: { appRoot },
      seedFiles: [],
      templateKey: "tpl-in-use",
    });

    const { cli: pruneCli } = createFakeDockerCli((args) => {
      if (args[0] === "rmi") {
        return { exitCode: 1, stderr: "image is being used by running container" };
      }
      return undefined;
    });
    await pruneDockerSandboxTemplates({
      appRoot,
      dockerCli: pruneCli,
      now: Date.now() + 60_000,
      recentWindowMs: 1_000,
      retainCount: 0,
    });

    const { readdir } = await import("node:fs/promises");
    await expect(
      readdir(join(appRoot, ".eve", "sandbox-cache", "docker", "templates")),
    ).resolves.toEqual([defaultDockerTemplateImageTag("tpl-in-use")]);
  });
});
