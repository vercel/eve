import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { pathExists } from "#execution/sandbox/bindings/local-provider-utils.js";
import { connectJustBash } from "#execution/sandbox/just-bash-connection.js";
import { importOptionalEnginePackage } from "#internal/application/optional-package-import.js";
import { loadOptionalEnginePackage } from "#internal/application/optional-package-install.js";
import type {
  JustBashFilesystem,
  JustBashSandboxCreateOptions,
} from "#public/sandbox/just-bash-sandbox.js";
import type { SandboxConnection } from "#public/sandbox/provider.js";
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
  readonly experimental?: JustBashSandboxCreateOptions["experimental"];
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
  const customFilesystem = input.experimental?.filesystem;
  if (customFilesystem !== undefined) {
    try {
      filesystem = await customFilesystem({
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

  const { connection, environment } = await connectJustBash({
    customCommands: input.experimental?.customCommands,
    env: metadata === null ? undefined : { ...metadata.env },
    filesystem,
    justBash,
  });

  return {
    ...connection,
    async captureState() {
      await writeLocalMetadata(metadataPath, {
        env: environment(),
        version: LOCAL_SANDBOX_METADATA_VERSION,
      });
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
