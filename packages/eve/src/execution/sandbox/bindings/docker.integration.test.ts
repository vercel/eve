import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DockerDaemonUnavailableError,
  type DockerCli,
  type DockerCommandResult,
  type DockerProcess,
} from "#execution/sandbox/bindings/docker-cli.js";
import { createDockerSandboxProvider } from "#execution/sandbox/bindings/docker.js";
import { EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV } from "#execution/sandbox/development-run.js";
import {
  createDockerSandboxOptionsHash,
  DEFAULT_DOCKER_SANDBOX_IMAGE,
  resolveDockerSandboxOptions,
} from "#execution/sandbox/bindings/docker-options.js";
import { dockerTemplateImageReference } from "#execution/sandbox/bindings/docker-templates.js";
import type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { bufferToStream } from "#execution/sandbox/stream-utils.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";

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
  const createdContainerNames = new Set<string>();
  const killedStreams: (readonly string[])[] = [];

  function resolve(args: readonly string[]): DockerCommandResult {
    let partial = respond(args) ?? {};
    if (args[0] === "container" && args[1] === "inspect" && args[3] === "{{.Id}}") {
      const containerName = args.at(-1) ?? "unknown";
      if (createdContainerNames.has(containerName) || (partial.exitCode ?? 0) === 0) {
        partial = { ...partial, exitCode: 0, stdout: fakeDockerContainerIdentity(containerName) };
      }
    }
    const stdout = partial.stdout ?? "";
    const result = {
      exitCode: partial.exitCode ?? 0,
      stderr: partial.stderr ?? "",
      stdout,
      stdoutBytes: partial.stdoutBytes ?? Buffer.from(stdout, "utf8"),
    };
    if (args[0] === "run" && result.exitCode === 0) {
      const nameIndex = args.indexOf("--name");
      const containerName = nameIndex === -1 ? undefined : args[nameIndex + 1];
      if (containerName !== undefined) createdContainerNames.add(containerName);
    }
    return result;
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
  readonly options?: DockerSandboxEnvironmentOptions;
  readonly runtimeOptions?: DockerSandboxRuntimeOptions;
}) {
  return createSandboxProviderHarness(
    createDockerSandboxProvider(input.options, input.cli),
    input.runtimeOptions ?? {},
    { preparedArtifact: () => ({ imageReference: TEMPLATE_IMAGE }) },
  );
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

function fakeDockerContainerIdentity(containerName: string): string {
  return `sha256:${containerName}`;
}

const TEMPLATE_KEY = "eve-sbx-tpl-local-abc123";
const DEFAULT_DOCKER_OPTIONS_HASH = createDockerSandboxOptionsHash(resolveDockerSandboxOptions());
const TEMPLATE_IMAGE = dockerTemplateImageReference({
  optionsHash: DEFAULT_DOCKER_OPTIONS_HASH,
  templateKey: TEMPLATE_KEY,
});
const SESSION_KEY = "eve-sbx-ses-local-session-1";
const PROVIDER_CONTAINER_NAME = `eve-sbx-${createSandboxProviderIdentity({
  artifact: { imageReference: TEMPLATE_IMAGE },
  environment: createDockerSandboxOptionsHash(resolveDockerSandboxOptions(undefined)),
  open: {},
  sessionId: SESSION_KEY,
  version: 1,
}).slice(0, 32)}`;

describe("Docker provider prewarm", () => {
  it("uses a colocated Dockerfile as the template base image", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { calls, cli } = createFakeDockerCli((args) => {
      if (
        args[0] === "image" &&
        args[1] === "inspect" &&
        String(args.at(-1)).startsWith("eve-sandbox-template:")
      ) {
        return { exitCode: 1, stderr: "No such image" };
      }
      return undefined;
    });
    await mkdir(join(appRoot, "sandbox"), { recursive: true });
    await writeFile(join(appRoot, "sandbox", "Dockerfile"), "FROM node:24\n");

    await createEngine({ cli }).prepare({
      appRoot,
      seedFiles: [],
    });

    expect(findCall(calls, (args) => args[0] === "build")?.args).toEqual([
      "build",
      "--file",
      expect.stringMatching(/[\\/]dockerfiles[\\/][a-f0-9]{64}[\\/]Dockerfile$/u),
      "--tag",
      expect.stringMatching(/^eve-sandbox-dockerfile:/),
      expect.stringMatching(/[\\/]dockerfiles[\\/][a-f0-9]{64}$/u),
    ]);
    expect(findCall(calls, (args) => args[0] === "pull")).toBeUndefined();
    expect(findCall(calls, (args) => args[0] === "run")?.args).toContainEqual(
      expect.stringMatching(/^eve-sandbox-dockerfile:/),
    );
  });

  it("builds, seeds, commits, and cleans up when the template image is missing", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { calls, cli } = createFakeDockerCli((args) => {
      if (
        args[0] === "image" &&
        args[1] === "inspect" &&
        String(args.at(-1)).startsWith("eve-sandbox-template:")
      ) {
        return { exitCode: 1, stderr: "No such image" };
      }
      if (isImageInspect(args, DEFAULT_DOCKER_SANDBOX_IMAGE)) {
        return { exitCode: 1, stderr: "No such image" };
      }
      return undefined;
    });

    const result = await createEngine({ cli }).prepare({
      appRoot,
      seedFiles: [{ content: "# Weather skill\n", path: "/workspace/skills/weather.md" }],
    });

    expect(result.imageReference).toMatch(/^eve-sandbox-template:/u);

    const pull = findCall(calls, (args) => args[0] === "pull");
    expect(pull?.args).toEqual(["pull", DEFAULT_DOCKER_SANDBOX_IMAGE]);

    const run = findCall(calls, (args) => args[0] === "run");
    expect(run).toBeDefined();
    expect(run?.args).toContain("--entrypoint");
    expect(run?.args).toContain("/bin/sh");
    expect(run?.args).toContain(`eve.sandbox.role=template-build`);
    const buildContainerName = run?.args[run.args.indexOf("--name") + 1];
    expect(buildContainerName).toMatch(/^[a-f0-9]{24}-build-[a-f0-9]{8}$/u);

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
    expect(stop?.args).toEqual([
      "stop",
      "-t",
      "0",
      fakeDockerContainerIdentity(buildContainerName!),
    ]);

    const commit = findCall(calls, (args) => args[0] === "commit");
    expect(commit?.args.at(-2)).toBe(fakeDockerContainerIdentity(buildContainerName!));
    expect(commit?.args.at(-1)).toMatch(/^eve-sandbox-template:/u);

    const cleanup = findCall(calls, (args) => args[0] === "rm" && args[1] === "-f");
    expect(cleanup?.args.at(-1)).toBe(buildContainerName);
  });

  it("reuses a concurrently committed template image", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    let publishedReference: string | undefined;
    const { calls, cli } = createFakeDockerCli((args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return publishedReference === args.at(-1)
          ? { exitCode: 0, stdout: "sha256:peer\n" }
          : { exitCode: 1, stderr: "No such image" };
      }
      if (args[0] === "commit") {
        publishedReference = args.at(-1);
        return {
          exitCode: 1,
          stderr: `AlreadyExists: image "${publishedReference}" already exists`,
        };
      }
      return undefined;
    });

    const result = await createEngine({ cli }).prepare({ appRoot, seedFiles: [] });
    expect(result.imageReference).toBe(publishedReference);
    expect(
      calls.filter(({ args }) =>
        publishedReference === undefined ? false : isImageInspect(args, publishedReference),
      ),
    ).toHaveLength(2);
    expect(findCall(calls, (args) => args[0] === "rm" && args[1] === "-f")).toBeDefined();
  });

  it("preserves commit failures other than a concurrent publication", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    let committedReference: string | undefined;
    const { cli } = createFakeDockerCli((args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { exitCode: 1, stderr: "No such image" };
      }
      if (args[0] === "commit") {
        committedReference = args.at(-1);
        return { exitCode: 1, stderr: "disk full" };
      }
      return undefined;
    });

    await expect(createEngine({ cli }).prepare({ appRoot, seedFiles: [] })).rejects.toThrow(
      /Failed to commit sandbox template image .*: disk full/u,
    );
    expect(committedReference).toMatch(/^eve-sandbox-template:/u);
  });

  it("mounts compiled resources read-only while hydrating a writable template", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const resourcesPath = join(appRoot, "compiled-resources");
    await mkdir(join(resourcesPath, "workspace"), { recursive: true });
    await writeFile(join(resourcesPath, "workspace", "README.md"), "immutable seed");
    const { calls, cli } = createFakeDockerCli((args) => {
      if (
        args[0] === "image" &&
        args[1] === "inspect" &&
        String(args.at(-1)).startsWith("eve-sandbox-template:")
      ) {
        return { exitCode: 1, stderr: "No such image" };
      }
      return undefined;
    });

    await createEngine({ cli }).prepare({
      resourcesKey: "resources-hash",
      resourcesPath,
      appRoot,
      seedFiles: [],
    });

    const run = findCall(calls, (args) => args[0] === "run");
    expect(run?.args).toContain(
      `type=bind,src=${join(appRoot, "docker", "resources", "resources-hash")},dst=/eve/resources,readonly`,
    );
    expect(
      findCall(
        calls,
        (args) =>
          args[0] === "exec" &&
          (args.at(-1) ?? "").includes("cp -a /eve/resources/workspace/. /workspace/"),
      ),
    ).toBeDefined();
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
      createEngine({ cli }).prepare({
        appRoot,
        seedFiles: [],
      }),
    ).rejects.toThrow(DockerDaemonUnavailableError);
  });
});

describe("Docker provider create", () => {
  it("throws SandboxTemplateNotProvisionedError when the template image is missing", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { cli } = createFakeDockerCli((args) => {
      if (isContainerInspect(args)) {
        return { exitCode: 1, stderr: "No such container" };
      }
      if (
        args[0] === "image" &&
        args[1] === "inspect" &&
        String(args.at(-1)).startsWith("eve-sandbox-template:")
      ) {
        return { exitCode: 1, stderr: "No such image" };
      }
      return undefined;
    });

    await expect(
      createEngine({ cli }).openSession({
        appRoot,
        sandboxName: SESSION_KEY,
      }),
    ).rejects.toThrow(SandboxTemplateNotProvisionedError);
  });

  it("preserves the container launch error when a template-backed container fails to start", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { cli } = createFakeDockerCli((args) => {
      if (isContainerInspect(args)) {
        return { exitCode: 1, stderr: "No such container" };
      }
      if (
        args[0] === "image" &&
        args[1] === "inspect" &&
        String(args.at(-1)).startsWith("eve-sandbox-template:")
      ) {
        return { exitCode: 0, stdout: "sha256:abc\n" };
      }
      if (args[0] === "run") {
        return { exitCode: 1, stderr: "template-backed container failed to start" };
      }
      return undefined;
    });

    await expect(
      createEngine({ cli }).openSession({
        appRoot,
        sandboxName: SESSION_KEY,
      }),
    ).rejects.toThrow("template-backed container failed to start");
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
      const handle = await createEngine({ cli }).openSession({
        appRoot,
        sandboxName: SESSION_KEY,
      });

      const run = findCall(calls, (args) => args[0] === "run");
      expect(run?.args).toContain(PROVIDER_CONTAINER_NAME);
      expect(run?.args).toContain("eve.sandbox.role=session");
      expect(run?.args.at(-3)).toBe(TEMPLATE_IMAGE);

      // No base setup against template-backed sessions — the template
      // image already carries it.
      expect(
        findCall(calls, (args) => args[0] === "exec" && args.includes("/bin/sh")),
      ).toBeUndefined();

      // An authored stop releases the container; filesystem state survives
      // for the next `create` to restart from.
      await handle.onSessionStop();
      expect(findCall(calls, (args) => args[0] === "stop")?.args).toEqual([
        "stop",
        "-t",
        "0",
        fakeDockerContainerIdentity(PROVIDER_CONTAINER_NAME),
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

    await createEngine({ cli }).openSession({
      appRoot,
      sandboxName: SESSION_KEY,
    });

    expect(findCall(calls, (args) => args[0] === "start")?.args).toEqual([
      "start",
      PROVIDER_CONTAINER_NAME,
    ]);
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

    const engine = createEngine({ cli });
    const { state } = await engine.start({ appRoot, sandboxName: SESSION_KEY });
    await engine.openSession({
      existing: state,
      appRoot,
      sandboxName: SESSION_KEY,
    });

    expect(findCall(calls, (args) => args[0] === "start")).toBeUndefined();
    expect(findCall(calls, (args) => args[0] === "run")).toBeUndefined();
  });

  it("attaches to the peer container when another process wins the create race", async () => {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    let peerCreated = false;
    const { calls, cli } = createFakeDockerCli((args) => {
      if (isContainerInspect(args)) {
        return peerCreated ? { exitCode: 0, stdout: "true\n" } : { exitCode: 1 };
      }
      if (args[0] === "run") {
        peerCreated = true;
        return {
          exitCode: 125,
          stderr: `docker: Error response from daemon: Conflict. The container name "/${PROVIDER_CONTAINER_NAME}" is already in use by container "d6b4ad87".`,
        };
      }
      return undefined;
    });

    await createEngine({ cli }).openSession({ appRoot, sandboxName: SESSION_KEY });

    expect(calls.filter(({ args }) => args[0] === "run")).toHaveLength(1);
    expect(findCall(calls, (args) => args[0] === "start")).toBeUndefined();
  });

  async function createRunningSessionHandle(input: {
    readonly respond?: (args: readonly string[]) => FakeResponse | undefined;
    readonly options?: DockerSandboxEnvironmentOptions;
  }) {
    const appRoot = await createScratchDirectory("eve-docker-sandbox-");
    const { calls, cli, killedStreams } = createFakeDockerCli((args) => {
      if (isContainerInspect(args) && args[3] === "{{.State.Running}}") {
        return { exitCode: 0, stdout: "true\n" };
      }
      return input.respond?.(args);
    });
    const handle = await createEngine({ cli, options: input.options }).openSession({
      appRoot,
      sandboxName: SESSION_KEY,
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

    const result = await handle.sandbox.run({
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
      fakeDockerContainerIdentity(PROVIDER_CONTAINER_NAME),
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

    const spawned = await handle.sandbox.spawn({ command: "sleep 300" });
    const spawnExec = findCall(calls, (args) => args[0] === "exec" && args.includes("bash"));
    const wrapper = String(spawnExec?.args.at(-1));
    const pidFilePath = /'(\/tmp\/\.eve-sbx-spawn-[0-9a-f-]+\.pid)'/.exec(wrapper)?.[1];
    expect(pidFilePath).toBeDefined();

    await spawned.kill();

    const treeKill = findCall(calls, (args) => args.includes("eve-kill-tree"));
    expect(treeKill?.args.slice(0, 2)).toEqual([
      "exec",
      fakeDockerContainerIdentity(PROVIDER_CONTAINER_NAME),
    ]);
    expect(treeKill?.args.at(-1)).toBe(pidFilePath);
    expect(String(treeKill?.args.at(-3))).toContain("kill_tree");
    // The local docker exec client is killed after the in-container
    // tree kill so the leaked-process window stays closed.
    expect(killedStreams).toHaveLength(1);
  });

  it("abort tree-kills the spawned process inside the container", async () => {
    const { calls, handle } = await createRunningSessionHandle({});
    const controller = new AbortController();

    await handle.sandbox.spawn({ abortSignal: controller.signal, command: "sleep 300" });
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

    await expect(handle.sandbox.readTextFile({ path: "missing.txt" })).resolves.toBeNull();
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

    await handle.sandbox.writeBinaryFile({ content: bytes, path: "assets/fixture.bin" });
    const write = findCall(calls, (args) => args[0] === "exec" && args[1] === "-i");
    written = write?.stdin;
    expect(write?.args.at(-1)).toContain("mkdir -p '/workspace/assets'");
    expect(written?.equals(bytes)).toBe(true);

    const readBack = await handle.sandbox.readBinaryFile({ path: "assets/fixture.bin" });
    expect(readBack === null ? null : Buffer.from(readBack).equals(bytes)).toBe(true);
  });

  it("maps removePath options onto rm flags", async () => {
    const { calls, handle } = await createRunningSessionHandle({});

    await handle.sandbox.removePath({ force: true, path: "skills/tenant", recursive: true });

    const remove = findCall(calls, (args) => args[0] === "exec" && args.includes("rm"));
    expect(remove?.args).toEqual([
      "exec",
      fakeDockerContainerIdentity(PROVIDER_CONTAINER_NAME),
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

    await handle.sandbox.setNetworkPolicy("deny-all");

    expect(
      findCall(calls, (args) => args[0] === "network" && args[1] === "disconnect")?.args,
    ).toEqual([
      "network",
      "disconnect",
      "--force",
      "bridge",
      fakeDockerContainerIdentity(PROVIDER_CONTAINER_NAME),
    ]);
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

    await handle.sandbox.setNetworkPolicy("allow-all");

    const networkCalls = calls
      .filter((call) => call.args[0] === "network")
      .map((call) => call.args);
    expect(networkCalls).toEqual([
      [
        "network",
        "disconnect",
        "--force",
        "none",
        fakeDockerContainerIdentity(PROVIDER_CONTAINER_NAME),
      ],
      ["network", "connect", "bridge", fakeDockerContainerIdentity(PROVIDER_CONTAINER_NAME)],
    ]);
  });

  it("rejects domain-level network policies with guidance toward the Vercel provider", async () => {
    const { handle } = await createRunningSessionHandle({});

    await expect(handle.sandbox.setNetworkPolicy({ allow: { "*": [] } })).rejects.toThrow(
      /Vercel provider/,
    );
  });
});
