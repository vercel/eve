import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { IFileSystem } from "just-bash";

import { pathExists } from "#execution/sandbox/bindings/local-provider-utils.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { importOptionalEnginePackage } from "#execution/sandbox/provider-host.js";
import { loadOptionalEnginePackage } from "#internal/application/optional-package-install.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import { SANDBOX_AGENT_ENV, type SandboxConnection } from "#public/sandbox/provider.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

const LOCAL_SANDBOX_METADATA_VERSION = 1;
const LOCAL_SANDBOX_FILESYSTEM_DIRECTORY_NAME = "fs";
const LOCAL_SANDBOX_METADATA_FILE_NAME = "metadata.json";
const JUST_BASH_PACKAGE_NAME = "just-bash";

type JustBashModule = typeof import("just-bash");

interface LocalSandboxMetadata {
  readonly env: Readonly<Record<string, string>>;
  readonly version: typeof LOCAL_SANDBOX_METADATA_VERSION;
}

/**
 * One just-bash interpreter over a session or template root. `stop()` and
 * `close()` both end the interpreter, which lives in this process; the root's
 * files stay.
 */
export interface BashSandbox extends SandboxConnection {
  /** Records the interpreter's environment, so sessions created from this template start with it. */
  captureState(): Promise<void>;
  close(): Promise<void>;
}

let justBashModulePromise: Promise<JustBashModule> | undefined;

/**
 * Loads `just-bash` from the application's own dependency tree. The
 * package is intentionally not bundled with eve — the provider is
 * opt-in — so when template preparation finds it missing during `eve dev`,
 * eve installs it into the project (unless `autoInstall: false`). Every
 * other load fails with an actionable install error instead.
 */
async function loadJustBashModule(input: {
  readonly appRoot: string;
  readonly autoInstall: boolean;
  readonly install: boolean;
}): Promise<JustBashModule> {
  const load = {
    appRoot: input.appRoot,
    importModule: async () => await import("just-bash"),
    missingMessage:
      "The just-bash sandbox provider requires the `just-bash` package, which is not bundled " +
      "with eve. Install it in your application (for example `pnpm add -D just-bash`), or use " +
      "DockerSandbox or DefaultSandbox instead.",
    packageName: JUST_BASH_PACKAGE_NAME,
  };
  justBashModulePromise ??= (
    input.install
      ? loadOptionalEnginePackage<JustBashModule>({
          ...load,
          autoInstall: input.autoInstall,
          ignoredOptionalDependencies: ["@mongodb-js/zstd", "node-liblzma"],
        })
      : importOptionalEnginePackage<JustBashModule>(load)
  ).catch((error: unknown) => {
    justBashModulePromise = undefined;
    throw error;
  });
  return await justBashModulePromise;
}

export async function createBashSandbox(input: {
  readonly autoInstall: boolean;
  readonly customCommands?: JustBashSandboxCreateOptions["customCommands"];
  readonly filesystem?: JustBashSandboxCreateOptions["filesystem"];
  /** Lets `eve dev` install a missing `just-bash`, which only template preparation does. */
  readonly install: boolean;
  resolveProjectPath(path: string): string;
  readonly rootPath: string;
  readonly storagePath: string;
}): Promise<BashSandbox> {
  const justBash = await loadJustBashModule({
    appRoot: input.resolveProjectPath("."),
    autoInstall: input.autoInstall,
    install: input.install,
  });
  const { ReadWriteFs, Sandbox } = justBash;
  const filesystemRootPath = resolveLocalSandboxFilesystemRootPath(input.rootPath);
  const metadataPath = resolveLocalSandboxMetadataPath(input.rootPath);
  const metadata = await readLocalMetadata(metadataPath);

  await mkdir(filesystemRootPath, { recursive: true });

  const defaultFilesystem = new ReadWriteFs({
    allowSymlinks: true,
    maxFileReadSize: Number.MAX_SAFE_INTEGER,
    root: filesystemRootPath,
  });
  let filesystem: IFileSystem = defaultFilesystem;
  if (input.filesystem !== undefined) {
    try {
      filesystem = await input.filesystem({
        defaultFilesystem,
        resolveProjectPath: (path) => input.resolveProjectPath(path),
        storagePath: input.storagePath,
        justBash,
      });
    } catch (error) {
      throw new Error("Failed to create the custom just-bash filesystem.", { cause: error });
    }
  }

  await ensureLocalSandboxDirectories(filesystem);

  const sandbox = await Sandbox.create({
    cwd: WORKSPACE_ROOT,
    customCommands: input.customCommands === undefined ? undefined : [...input.customCommands],
    env: metadata === null ? undefined : { ...metadata.env },
    fs: filesystem,
    network: {
      dangerouslyAllowFullInternetAccess: true,
    },
  });
  let stopped: Promise<void> | undefined;
  const stop = async () => await (stopped ??= sandbox.stop());

  return {
    async captureState() {
      await writeLocalMetadata(metadataPath, {
        env: { ...sandbox.bashEnvInstance.getEnv() },
        version: LOCAL_SANDBOX_METADATA_VERSION,
      });
    },
    close: stop,
    async readFile({ path }) {
      try {
        return await filesystem.readFileBuffer(path);
      } catch (error) {
        if (!(await filesystem.exists(path))) return null;
        throw error;
      }
    },
    async removePath(options) {
      await filesystem.rm(options.path, {
        force: options.force,
        recursive: options.recursive,
      });
    },
    async spawn(options) {
      if (options.abortSignal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      // Every command already starts in /workspace. Wrapping it anyway would
      // let a trailing `# comment` swallow the subshell's closing parenthesis.
      const wrapped =
        options.workingDirectory === WORKSPACE_ROOT
          ? options.command
          : `( cd ${shellQuote(options.workingDirectory)} && ${options.command} )`;
      // just-bash has no separate `bash` executable — it IS the bash
      // interpreter. The `eval` builtin re-parses its single string
      // argument as a shell line, which is the only way to feed an
      // arbitrary shell command into the object-form `runCommand`
      // (the only form that supports `detached`).
      const command = await sandbox.runCommand({
        args: [wrapped],
        cmd: "eval",
        detached: true,
        // just-bash has no sandbox-level environment for `SANDBOX_AGENT_ENV`, so each command gets it.
        env: { ...SANDBOX_AGENT_ENV, ...options.env },
        signal: options.abortSignal,
      });
      return adaptMultiplexedCommandToSandboxProcess({
        command,
        getOutput: (log) => log.type,
      });
    },
    stop,
    async writeFiles({ files }) {
      for (const file of files) {
        await filesystem.mkdir(dirname(file.path), { recursive: true });
        await filesystem.writeFile(file.path, file.content);
      }
    },
  };
}

function resolveLocalSandboxFilesystemRootPath(rootPath: string): string {
  return `${rootPath}/${LOCAL_SANDBOX_FILESYSTEM_DIRECTORY_NAME}`;
}

function resolveLocalSandboxMetadataPath(rootPath: string): string {
  return `${rootPath}/${LOCAL_SANDBOX_METADATA_FILE_NAME}`;
}

async function ensureLocalSandboxDirectories(filesystem: IFileSystem): Promise<void> {
  await filesystem.mkdir(WORKSPACE_ROOT, {
    recursive: true,
  });
}

async function readLocalMetadata(metadataPath: string): Promise<LocalSandboxMetadata | null> {
  if (!(await pathExists(metadataPath))) {
    return null;
  }

  const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));

  if (
    !isRecord(metadata) ||
    metadata.version !== LOCAL_SANDBOX_METADATA_VERSION ||
    !isStringRecord(metadata.env)
  ) {
    return null;
  }

  return {
    env: metadata.env,
    version: LOCAL_SANDBOX_METADATA_VERSION,
  };
}

async function writeLocalMetadata(
  metadataPath: string,
  metadata: LocalSandboxMetadata,
): Promise<void> {
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}
