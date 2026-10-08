import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxDockerfile as SandboxDockerfileInput } from "#execution/sandbox/dockerfile.js";

const OCI_PLATFORM = "linux/amd64";
const SHA256_DIGEST = /sha256:[a-f0-9]{64}/u;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;

interface CommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

export interface OciCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: {
      readonly env?: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
      readonly stdin?: string;
      readonly streamOutput?: boolean;
    },
  ): Promise<CommandResult>;
}

export interface OciImagePublisher {
  publish(input: {
    readonly dockerfile: SandboxDockerfileInput;
    readonly imageReference: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

export function createOciImagePublisher(input: {
  readonly authToken: string;
  readonly engine?: "buildah" | "docker";
  readonly registry: string;
  readonly runner?: OciCommandRunner;
  readonly username: string;
}): OciImagePublisher {
  const runner = input.runner ?? createOciCommandRunner();
  return {
    async publish(publishInput) {
      const engine = input.engine ?? (process.env.VERCEL ? "buildah" : "docker");
      const directory = await mkdtemp(join(tmpdir(), "eve-oci-auth-"));
      await chmod(directory, 0o700);
      const env: Readonly<Record<string, string>> =
        engine === "docker"
          ? { DOCKER_CONFIG: directory }
          : { REGISTRY_AUTH_FILE: join(directory, "auth.json") };
      try {
        await login({
          authToken: input.authToken,
          engine,
          env,
          registry: input.registry,
          runner,
          signal: publishInput.signal,
          username: input.username,
        });
        await build({ directory, engine, env, input: publishInput, runner });
        const digest = await push({ engine, env, input: publishInput, runner });
        return `${stripImageTag(publishInput.imageReference)}@${digest}`;
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  };
}

async function login(input: {
  readonly authToken: string;
  readonly engine: "buildah" | "docker";
  readonly env: Readonly<Record<string, string>>;
  readonly registry: string;
  readonly runner: OciCommandRunner;
  readonly signal?: AbortSignal;
  readonly username: string;
}): Promise<void> {
  try {
    await input.runner.run(
      input.engine,
      ["login", input.registry, "--username", input.username, "--password-stdin"],
      { env: input.env, signal: input.signal, stdin: input.authToken },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll(input.authToken, "[redacted]"));
  }
}

async function build(input: {
  readonly directory: string;
  readonly engine: "buildah" | "docker";
  readonly env: Readonly<Record<string, string>>;
  readonly input: {
    readonly dockerfile: SandboxDockerfileInput;
    readonly imageReference: string;
    readonly signal?: AbortSignal;
  };
  readonly runner: OciCommandRunner;
}): Promise<void> {
  const common = [
    "--platform",
    OCI_PLATFORM,
    "--tag",
    input.input.imageReference,
    "--file",
    input.input.dockerfile.path,
    input.input.dockerfile.contextPath,
  ];
  if (input.engine === "docker") {
    await input.runner.run("docker", ["build", ...common], {
      env: input.env,
      signal: input.input.signal,
      streamOutput: true,
    });
    return;
  }

  const configPath = join(input.directory, "registries.conf");
  await writeFile(
    configPath,
    'unqualified-search-registries = ["docker.io"]\nshort-name-mode = "permissive"\n',
  );
  await input.runner.run(
    "buildah",
    ["--registries-conf", configPath, "build", "--layers", "--network", "host", ...common],
    { env: input.env, signal: input.input.signal, streamOutput: true },
  );
}

async function push(input: {
  readonly engine: "buildah" | "docker";
  readonly env: Readonly<Record<string, string>>;
  readonly input: { readonly imageReference: string; readonly signal?: AbortSignal };
  readonly runner: OciCommandRunner;
}): Promise<string> {
  if (input.engine === "docker") {
    const result = await input.runner.run("docker", ["push", input.input.imageReference], {
      env: input.env,
      signal: input.input.signal,
    });
    const digest = `${result.stdout}\n${result.stderr}`.match(SHA256_DIGEST)?.[0];
    if (digest !== undefined) return digest;
    const inspected = await input.runner.run(
      "docker",
      ["inspect", "--format", "{{index .RepoDigests 0}}", input.input.imageReference],
      { env: input.env, signal: input.input.signal },
    );
    return requireDigest(inspected.stdout);
  }

  const directory = await mkdtemp(join(tmpdir(), "eve-oci-digest-"));
  const digestPath = join(directory, "digest");
  try {
    await input.runner.run(
      "buildah",
      [
        "push",
        "--compression-format",
        "zstd",
        "--compression-level",
        "3",
        "--force-compression",
        "--format",
        "oci",
        "--digestfile",
        digestPath,
        input.input.imageReference,
      ],
      { env: input.env, signal: input.input.signal },
    );
    return requireDigest(await readFile(digestPath, "utf8"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function requireDigest(value: string): string {
  const digest = value.match(SHA256_DIGEST)?.[0];
  if (digest === undefined) {
    throw new Error("The OCI registry did not return a digest for the published image.");
  }
  return digest;
}

function stripImageTag(reference: string): string {
  const slash = reference.lastIndexOf("/");
  const colon = reference.lastIndexOf(":");
  return colon > slash ? reference.slice(0, colon) : reference;
}

function appendOutputTail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.byteLength >= MAX_COMMAND_OUTPUT_BYTES)
    return chunk.subarray(-MAX_COMMAND_OUTPUT_BYTES);
  const overflow = current.byteLength + chunk.byteLength - MAX_COMMAND_OUTPUT_BYTES;
  return Buffer.concat([overflow > 0 ? current.subarray(overflow) : current, chunk]);
}

export function createOciCommandRunner(): OciCommandRunner {
  return {
    run(command, args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          env: { ...process.env, ...options.env },
          signal: options.signal,
          stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        child.stdout?.on("data", (chunk: Buffer) => {
          if (options.streamOutput === true) process.stdout.write(chunk);
          stdout = appendOutputTail(stdout, chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (options.streamOutput === true) process.stderr.write(chunk);
          stderr = appendOutputTail(stderr, chunk);
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
          reject(
            error.code === "ENOENT"
              ? new Error(`The OCI image publisher requires the \`${command}\` command.`, {
                  cause: error,
                })
              : error,
          );
        });
        child.on("close", (code) => {
          const result = { stderr: stderr.toString("utf8"), stdout: stdout.toString("utf8") };
          if (code === 0) resolve(result);
          else reject(new Error(`${command} exited with code ${String(code)}: ${result.stderr}`));
        });
        if (options.stdin !== undefined) child.stdin?.end(options.stdin);
      });
    },
  };
}
