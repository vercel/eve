import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { pathExists } from "#execution/sandbox/bindings/local-provider-utils.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { importOptionalEnginePackage } from "#internal/application/optional-package-import.js";
import { loadOptionalEnginePackage } from "#internal/application/optional-package-install.js";
import type {
  JustBashFilesystem,
  JustBashSandboxCreateOptions,
} from "#public/sandbox/just-bash-sandbox.js";
import { SANDBOX_AGENT_ENV, type SandboxConnection } from "#public/sandbox/provider.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import { isObject } from "#shared/guards.js";

const LOCAL_SANDBOX_METADATA_VERSION = 1;
const LOCAL_SANDBOX_FILESYSTEM_DIRECTORY_NAME = "fs";
const LOCAL_SANDBOX_METADATA_FILE_NAME = "metadata.json";

type JustBashModule = typeof import("just-bash");

interface LocalSandboxMetadata {
  readonly env: Readonly<Record<string, string>>;
  readonly version: typeof LOCAL_SANDBOX_METADATA_VERSION;
}

/** One just-bash interpreter over a session or template root. The root's files outlive it. */
export interface BashSandbox extends SandboxConnection {
  /** Records the interpreter's environment, so sessions created from this template start with it. */
  captureState(): Promise<void>;
}

/**
 * The package is intentionally not bundled with eve — the provider is opt-in —
 * so it loads from the application's own dependency tree.
 */
const JUST_BASH_PACKAGE = {
  importModule: async () => await import("just-bash"),
  missingMessage:
    "The just-bash sandbox provider requires the `just-bash` package, which is not bundled " +
    "with eve. Install it in your application (for example `pnpm add -D just-bash`), or use " +
    "DockerSandbox or DefaultSandbox instead.",
  packageName: "just-bash",
};

/**
 * Loads `just-bash` for template preparation, installing it into the project
 * when it is missing during `eve dev` (unless `autoInstall` is false).
 */
export async function installJustBashModule(input: {
  readonly appRoot: string;
  readonly autoInstall: boolean;
}): Promise<JustBashModule> {
  return await loadOptionalEnginePackage<JustBashModule>({
    ...JUST_BASH_PACKAGE,
    appRoot: input.appRoot,
    autoInstall: input.autoInstall,
    ignoredOptionalDependencies: ["@mongodb-js/zstd", "node-liblzma"],
  });
}

/** Loads `just-bash` for a session without installing it. */
export async function importJustBashModule(appRoot: string): Promise<JustBashModule> {
  return await importOptionalEnginePackage<JustBashModule>({ ...JUST_BASH_PACKAGE, appRoot });
}

export async function createBashSandbox(input: {
  readonly customCommands?: JustBashSandboxCreateOptions["customCommands"];
  readonly filesystem?: JustBashSandboxCreateOptions["filesystem"];
  readonly justBash: JustBashModule;
  resolveProjectPath(path: string): string;
  readonly rootPath: string;
  readonly storagePath: string;
}): Promise<BashSandbox> {
  const { justBash } = input;
  const filesystemRootPath = resolveLocalSandboxFilesystemRootPath(input.rootPath);
  const metadataPath = resolveLocalSandboxMetadataPath(input.rootPath);
  const metadata = await readLocalMetadata(metadataPath);

  await mkdir(filesystemRootPath, { recursive: true });

  const defaultFilesystem = new justBash.ReadWriteFs({
    allowSymlinks: true,
    maxFileReadSize: Number.MAX_SAFE_INTEGER,
    root: filesystemRootPath,
  });
  let filesystem: JustBashFilesystem = defaultFilesystem;
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

  await filesystem.mkdir(WORKSPACE_ROOT, { recursive: true });

  const sandbox = await justBash.Sandbox.create({
    cwd: WORKSPACE_ROOT,
    customCommands: input.customCommands === undefined ? undefined : [...input.customCommands],
    env: metadata === null ? undefined : { ...metadata.env },
    fs: filesystem,
    network: {
      dangerouslyAllowFullInternetAccess: true,
    },
  });

  return {
    async captureState() {
      await writeLocalMetadata(metadataPath, {
        env: { ...sandbox.bashEnvInstance.getEnv() },
        version: LOCAL_SANDBOX_METADATA_VERSION,
      });
    },
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
      // The command sits on its own lines so a trailing `# comment` cannot
      // swallow the closing brace. `cd X || exit` would lose cd's error in
      // just-bash, so the braces keep `&&` applying to the whole command.
      const wrapped = `( cd ${shellQuote(options.workingDirectory)} && {\n${options.command}\n} )`;
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
    async stop() {
      await sandbox.stop();
    },
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

async function readLocalMetadata(metadataPath: string): Promise<LocalSandboxMetadata | null> {
  if (!(await pathExists(metadataPath))) {
    return null;
  }

  const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));

  if (
    !isObject(metadata) ||
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

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}
