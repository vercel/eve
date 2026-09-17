import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxDockerfile as SandboxDockerfileInput } from "#execution/sandbox/dockerfile.js";

const OCI_PLATFORM = "linux/amd64";
const SHA256_DIGEST = /sha256:[a-f0-9]{64}/u;

interface CommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

export interface OciCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { readonly signal?: AbortSignal; readonly stdin?: string },
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
      if (engine === "docker" || !hasRegistryAuthFile()) {
        await login({
          authToken: input.authToken,
          engine,
          registry: input.registry,
          runner,
          signal: publishInput.signal,
          username: input.username,
        });
      }
      await build({ engine, input: publishInput, runner });
      const digest = await push({ engine, input: publishInput, runner });
      return `${stripImageTag(publishInput.imageReference)}@${digest}`;
    },
  };
}

async function login(input: {
  readonly authToken: string;
  readonly engine: "buildah" | "docker";
  readonly registry: string;
  readonly runner: OciCommandRunner;
  readonly signal?: AbortSignal;
  readonly username: string;
}): Promise<void> {
  try {
    await input.runner.run(
      input.engine,
      ["login", input.registry, "--username", input.username, "--password-stdin"],
      { signal: input.signal, stdin: input.authToken },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll(input.authToken, "[redacted]"), { cause: error });
  }
}

async function build(input: {
  readonly engine: "buildah" | "docker";
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
    await input.runner.run("docker", ["build", ...common], { signal: input.input.signal });
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "eve-oci-config-"));
  const configPath = join(directory, "registries.conf");
  try {
    await writeFile(
      configPath,
      'unqualified-search-registries = ["docker.io"]\nshort-name-mode = "permissive"\n',
    );
    await input.runner.run(
      "buildah",
      ["--registries-conf", configPath, "build", "--layers", "--network", "host", ...common],
      { signal: input.input.signal },
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function push(input: {
  readonly engine: "buildah" | "docker";
  readonly input: { readonly imageReference: string; readonly signal?: AbortSignal };
  readonly runner: OciCommandRunner;
}): Promise<string> {
  if (input.engine === "docker") {
    const result = await input.runner.run("docker", ["push", input.input.imageReference], {
      signal: input.input.signal,
    });
    const digest = `${result.stdout}\n${result.stderr}`.match(SHA256_DIGEST)?.[0];
    if (digest !== undefined) return digest;
    const inspected = await input.runner.run(
      "docker",
      ["inspect", "--format", "{{index .RepoDigests 0}}", input.input.imageReference],
      { signal: input.input.signal },
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
      { signal: input.input.signal },
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

function hasRegistryAuthFile(): boolean {
  const explicit = process.env.REGISTRY_AUTH_FILE?.trim();
  if (explicit !== undefined && explicit.length > 0) return existsSync(explicit);
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return existsSync(join(configHome, "containers", "auth.json"));
}

function createOciCommandRunner(): OciCommandRunner {
  return {
    run(command, args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          signal: options.signal,
          stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
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
          const result = {
            stderr: Buffer.concat(stderr).toString("utf8"),
            stdout: Buffer.concat(stdout).toString("utf8"),
          };
          if (code === 0) resolve(result);
          else reject(new Error(`${command} exited with code ${String(code)}: ${result.stderr}`));
        });
        if (options.stdin !== undefined) child.stdin?.end(options.stdin);
      });
    },
  };
}
