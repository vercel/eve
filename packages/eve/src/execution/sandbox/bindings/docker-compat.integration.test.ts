import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import { EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV } from "#execution/sandbox/development-run.js";
import { createDockerSandboxHarness } from "#internal/testing/docker-sandbox-runtime.js";
import {
  createFakeDockerCli,
  fakeDockerContainerIdentity,
  findCall,
  isContainerInspect,
  type FakeResponse,
} from "#internal/testing/fake-docker-cli.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";

const createScratchDirectory = useTemporaryDirectories();

function createEngine(input: {
  readonly cli: DockerCli;
  readonly options?: DockerSandboxEnvironmentOptions;
  readonly runtimeOptions?: DockerSandboxRuntimeOptions;
}) {
  return createDockerSandboxHarness({ ...input, runtimeOptions: input.runtimeOptions ?? {} });
}

// Literal values recorded from the previous release. Running sessions persist
// container names and state, and deployments ship image references, so these
// must stay byte-identical across provider refactors.
describe("Docker provider compatibility with the previous release", () => {
  const ALICE_STORAGE = "/srv/alice-app/.eve/sandbox";
  const PREVIOUS_ARTIFACT = { imageReference: "eve-sandbox-template:previous-release" };
  const ALICE_CONTAINER = "eve-sbx-9b576ac2a11e0d99ef5520deef1b41fa";

  // `eve dev` labels containers with its run id; the recorded arguments predate it.
  beforeEach(() => {
    vi.stubEnv(EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function respondRunning(running: boolean) {
    return (args: readonly string[]): FakeResponse | undefined => {
      if (isContainerInspect(args) && args[3] === "{{.State.Running}}") {
        return running
          ? { exitCode: 0, stdout: "true\n" }
          : { exitCode: 1, stderr: "Error: No such container" };
      }
      return undefined;
    };
  }

  it("derives the same container name and state from the storage path and session id", async () => {
    const engine = createEngine({ cli: createFakeDockerCli(respondRunning(true)).cli });
    const start = (appRoot: string) =>
      engine.start({ appRoot, prepared: PREVIOUS_ARTIFACT, sandboxName: "ses_alice" });

    expect(JSON.stringify((await start(ALICE_STORAGE)).state)).toBe(
      `{"containerName":"${ALICE_CONTAINER}","version":2}`,
    );
    expect(JSON.stringify((await start("/srv/bob-app/.eve/sandbox")).state)).toBe(
      '{"containerName":"eve-sbx-a5c2666363bfc0bdb9e2f99bb7812b6c","version":2}',
    );
  });

  it("creates the session container with the same docker run arguments", async () => {
    const { calls, cli } = createFakeDockerCli(respondRunning(false));
    await createEngine({
      cli,
      options: { env: { FOO: "bar" } },
      runtimeOptions: { networkPolicy: "deny-all" },
    }).start({ appRoot: ALICE_STORAGE, prepared: PREVIOUS_ARTIFACT, sandboxName: "ses_alice" });

    expect(findCall(calls, (args) => args[0] === "run")?.args).toEqual([
      "run",
      "-d",
      "--name",
      ALICE_CONTAINER,
      "--label",
      "eve.sandbox=1",
      "--label",
      "eve.sandbox.role=session",
      "--label",
      "eve.sandbox.tag.agent=ses_alice",
      "--label",
      "eve.sandbox.tag.sessionId=ses_alice",
      "-e",
      "AI_AGENT=eve",
      "-e",
      "FOO=bar",
      "--network",
      "none",
      "--workdir",
      "/workspace",
      "--entrypoint",
      "/bin/sh",
      "eve-sandbox-template:previous-release",
      "-c",
      "sleep 2147483647",
    ]);
  });

  it("resumes a container from state the previous release recorded", async () => {
    const { calls, cli } = createFakeDockerCli(respondRunning(true));
    const handle = await createEngine({ cli }).openSession({
      appRoot: ALICE_STORAGE,
      existing: { containerName: ALICE_CONTAINER, version: 2 },
      prepared: PREVIOUS_ARTIFACT,
      sandboxName: "ses_alice",
    });
    await handle.sandbox.run({ command: "true" });

    expect(calls.filter(({ args }) => isContainerInspect(args)).map(({ args }) => args)).toEqual([
      ["container", "inspect", "--format", "{{.State.Running}}", ALICE_CONTAINER],
      ["container", "inspect", "--format", "{{.Id}}", ALICE_CONTAINER],
    ]);
    expect(findCall(calls, (args) => args[0] === "exec")?.args.slice(0, 4)).toEqual([
      "exec",
      "-w",
      "/workspace",
      fakeDockerContainerIdentity(ALICE_CONTAINER),
    ]);
    expect(findCall(calls, (args) => args[0] === "run" || args[0] === "start")).toBeUndefined();
  });

  it("reuses an existing template image under the same reference", async () => {
    const reference = "eve-sandbox-template:cbe866eb1c12526f7d05ae99-9f22a0e294ab3200fb39";
    const { calls, cli } = createFakeDockerCli();
    const appRoot = await createScratchDirectory("eve-docker-golden-");

    await expect(
      createEngine({ cli, options: { image: "alpine:3.21" } }).prepare({
        appRoot,
        sourceRevision: "golden-revision",
      }),
    ).resolves.toEqual({ imageReference: reference });
    expect(
      findCall(calls, (args) => ["build", "commit", "pull", "run"].includes(args[0] ?? "")),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "a base image",
      artifact: "eve-sandbox-template:cbe866eb1c12526f7d05ae99-9f22a0e294ab3200fb39",
      baseImage: "alpine:3.21",
      runOptions: () => ["-e", "AI_AGENT=eve"],
      templateKey: "cbe866eb1c12526f7d05ae99",
    },
    {
      name: "custom options with workspace and skill files",
      artifact: "eve-sandbox-template:29da3fc1447dbbd1d40ca174-c22499590fe4cda16117",
      baseImage: "alpine:3.21",
      options: {
        env: { FOO: "bar" },
        image: "alpine:3.21",
        pullPolicy: "always",
      } satisfies DockerSandboxEnvironmentOptions,
      runOptions: () => ["-e", "AI_AGENT=eve", "-e", "FOO=bar"],
      seeded: [
        ["/home/agent/.agents/skills/weather/SKILL.md", "# Weather\n"],
        ["/workspace/README.md", "hello\n"],
      ],
      skills: [{ content: "# Weather\n", relativePath: "weather/SKILL.md" }],
      templateKey: "29da3fc1447dbbd1d40ca174",
      workspace: [{ content: "hello\n", relativePath: "README.md" }],
    },
    {
      name: "a sandbox Dockerfile",
      artifact: "eve-sandbox-template:6fb11595f3665a922c1175ad-9f22a0e294ab3200fb39",
      baseImage: "eve-sandbox-dockerfile:e96fef6018c802ba66c9c039",
      dockerfile: "FROM alpine:3.21\n",
      runOptions: () => ["-e", "AI_AGENT=eve"],
      templateKey: "6fb11595f3665a922c1175ad",
    },
    {
      name: "materialized resources",
      artifact: "eve-sandbox-template:8022e5c008de8d0002ed9faf-9f22a0e294ab3200fb39",
      baseImage: "alpine:3.21",
      materialized: true,
      runOptions: (appRoot: string) => [
        "-e",
        "AI_AGENT=eve",
        "--mount",
        `type=bind,src=${join(appRoot, "docker", "resources", "golden-resources")},dst=/eve/resources,readonly`,
      ],
      templateKey: "8022e5c008de8d0002ed9faf",
    },
  ])("builds the template image with $name under the same references", async (golden) => {
    const appRoot = await createScratchDirectory("eve-docker-golden-");
    if (golden.dockerfile !== undefined) {
      await mkdir(join(appRoot, "sandbox"), { recursive: true });
      await writeFile(join(appRoot, "sandbox", "Dockerfile"), golden.dockerfile);
    }
    let resourcesPath: string | undefined;
    if (golden.materialized === true) {
      resourcesPath = join(appRoot, "compiled-resources");
      await mkdir(join(resourcesPath, "workspace"), { recursive: true });
      await writeFile(join(resourcesPath, "workspace", "README.md"), "hello\n");
    }
    const { calls, cli } = createFakeDockerCli((args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { exitCode: 1, stderr: "No such image" };
      }
      if (args[0] === "exec" && String(args.at(-1)).includes('"$HOME"')) {
        return { streamStdout: "/home/agent\n" };
      }
      return undefined;
    });

    const artifact = await createEngine({
      cli,
      options: golden.options ?? { image: "alpine:3.21" },
    }).prepare({
      appRoot,
      resourcesKey: resourcesPath === undefined ? undefined : "golden-resources",
      resourcesPath,
      skills: golden.skills,
      sourceRevision: "golden-revision",
      workspace: golden.workspace,
    });

    expect(artifact).toEqual({ imageReference: golden.artifact });
    const run = findCall(calls, (args) => args[0] === "run")?.args ?? [];
    const buildContainer = run[3] ?? "";
    expect(buildContainer).toMatch(new RegExp(`^${golden.templateKey}-build-[0-9a-f]{8}$`, "u"));
    expect(run).toEqual([
      "run",
      "-d",
      "--name",
      buildContainer,
      "--label",
      "eve.sandbox=1",
      "--label",
      "eve.sandbox.role=template-build",
      ...golden.runOptions(appRoot),
      "--workdir",
      "/workspace",
      "--entrypoint",
      "/bin/sh",
      golden.baseImage,
      "-c",
      "sleep 2147483647",
    ]);
    expect(findCall(calls, (args) => args[0] === "commit")?.args).toEqual([
      "commit",
      "--change",
      "LABEL eve.sandbox=1",
      "--change",
      "LABEL eve.sandbox.role=template",
      "--change",
      `LABEL eve.sandbox.template-key=${golden.templateKey}`,
      fakeDockerContainerIdentity(buildContainer),
      golden.artifact,
    ]);
    const seeded = calls
      .filter(({ args }) => args[0] === "exec" && args[1] === "-i")
      .map(({ args, stdin }) => [/cat > '(.+)'$/u.exec(String(args.at(-1)))?.[1], String(stdin)])
      .sort();
    expect(seeded).toEqual(golden.seeded ?? []);
    if (golden.dockerfile !== undefined) {
      expect(findCall(calls, (args) => args[0] === "build")?.args[4]).toBe(golden.baseImage);
      expect(findCall(calls, (args) => args[0] === "rmi")?.args).toEqual(["rmi", golden.baseImage]);
    }
  });
});
