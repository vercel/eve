import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import type { SandboxProviderFiles } from "#shared/sandbox-provider.js";
import { expectDockerSuccess } from "#execution/sandbox/bindings/docker-utils.js";

export interface SandboxDockerfile {
  readonly contextPath: string;
  readonly contentHash: string;
  readonly path: string;
}

export async function materializeSandboxDockerfile(input: {
  readonly files: SandboxProviderFiles;
  readonly storagePath: string;
}): Promise<SandboxDockerfile | undefined> {
  let content: Uint8Array;
  try {
    content = await input.files.read("Dockerfile");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const paths = await input.files.list();
  const hash = createHash("sha256");
  const contents = await Promise.all(
    paths.map(async (path) => ({ content: await input.files.read(path), path })),
  );
  for (const file of contents)
    hash.update(file.path).update("\0").update(file.content).update("\0");
  const contentHash = hash.digest("hex");
  const contextPath = join(input.storagePath, "dockerfiles", contentHash);
  try {
    await access(join(contextPath, "Dockerfile"));
    return { contentHash, contextPath, path: join(contextPath, "Dockerfile") };
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
  const temporaryPath = `${contextPath}.${randomUUID()}.tmp`;
  await Promise.all(
    contents.map(async (file) => {
      const target = join(temporaryPath, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }),
  );
  if (!paths.includes("Dockerfile")) {
    await mkdir(temporaryPath, { recursive: true });
    await writeFile(join(temporaryPath, "Dockerfile"), content);
  }
  await mkdir(dirname(contextPath), { recursive: true });
  try {
    await rename(temporaryPath, contextPath);
  } catch (error) {
    try {
      await access(join(contextPath, "Dockerfile"));
    } catch {
      throw error;
    }
  } finally {
    await rm(temporaryPath, { force: true, recursive: true });
  }
  return { contentHash, contextPath, path: join(contextPath, "Dockerfile") };
}

export async function resolveSandboxDockerfile(
  agentRoot: string,
): Promise<SandboxDockerfile | undefined> {
  const path = join(agentRoot, "sandbox", "Dockerfile");
  try {
    await readFile(path);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
  const contextPath = dirname(path);
  return {
    contextPath,
    contentHash: await hashDirectory(contextPath),
    path,
  };
}

export function dockerfileImageReference(input: {
  readonly dockerfile: SandboxDockerfile;
  readonly templateKey: string;
}): string {
  return `eve-sandbox-dockerfile:${createHash("sha256")
    .update(`${input.templateKey}:${input.dockerfile.contentHash}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export async function buildSandboxDockerfile(input: {
  readonly cli: DockerCli;
  readonly dockerfile: SandboxDockerfile;
  readonly imageReference: string;
}): Promise<void> {
  expectDockerSuccess(
    await input.cli.run([
      "build",
      "--file",
      input.dockerfile.path,
      "--tag",
      input.imageReference,
      input.dockerfile.contextPath,
    ]),
    `build sandbox Dockerfile "${input.dockerfile.path}"`,
  );
}

const LOCAL_REGISTRY_CONTAINER = "eve-sandbox-registry";
const LOCAL_REGISTRY_HOST = "127.0.0.1:51921";

export async function publishDockerImageForMicrosandbox(input: {
  readonly cli: DockerCli;
  readonly imageReference: string;
}): Promise<string> {
  const inspect = await input.cli.run([
    "container",
    "inspect",
    "--format",
    "{{.State.Running}}",
    LOCAL_REGISTRY_CONTAINER,
  ]);
  if (inspect.exitCode !== 0) {
    expectDockerSuccess(
      await input.cli.run([
        "run",
        "--detach",
        "--name",
        LOCAL_REGISTRY_CONTAINER,
        "--publish",
        `${LOCAL_REGISTRY_HOST}:5000`,
        "registry:2",
      ]),
      "start the local microsandbox image registry",
    );
  } else if (inspect.stdout.trim() !== "true") {
    expectDockerSuccess(
      await input.cli.run(["start", LOCAL_REGISTRY_CONTAINER]),
      "restart the local microsandbox image registry",
    );
  }

  const target = `${LOCAL_REGISTRY_HOST}/eve/${input.imageReference.replace(":", "-")}`;
  expectDockerSuccess(
    await input.cli.run(["tag", input.imageReference, target]),
    `tag microsandbox image "${target}"`,
  );
  expectDockerSuccess(
    await input.cli.run(["push", target]),
    `publish microsandbox image "${target}"`,
  );
  return target;
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const paths = await collectFilePaths(root);
  for (const path of paths) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function collectFilePaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...(await collectFilePaths(path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths.sort();
}
