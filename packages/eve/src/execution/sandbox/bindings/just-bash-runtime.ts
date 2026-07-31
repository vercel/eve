import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { IFileSystem } from "just-bash";

import {
  createFileBackedInternalSandboxSession,
  pathExists,
} from "#execution/sandbox/bindings/local-workspace-utils.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { loadOptionalProviderPackage } from "#internal/application/optional-package-install.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type {
  SandboxProcess,
  SandboxRemovePathOptions,
  SandboxSession,
  SandboxSpawnOptions,
} from "#shared/sandbox-session.js";

const LOCAL_SANDBOX_METADATA_VERSION = 2;
const LOCAL_SANDBOX_FILESYSTEM_DIRECTORY_NAME = "fs";
const LOCAL_SANDBOX_METADATA_FILE_NAME = "metadata.json";
const JUST_BASH_PACKAGE_NAME = "just-bash";

type JustBashModule = typeof import("just-bash");

interface LocalSandboxMetadata {
  readonly env: Readonly<Record<string, string>>;
  readonly resourceId: string;
  readonly version: typeof LOCAL_SANDBOX_METADATA_VERSION;
}

export interface BashSandbox {
  captureState(): Promise<Record<string, unknown> | null>;
  dispose(): Promise<void>;
  readFileBytes(path: string): Promise<Buffer | null>;
  removePath(options: SandboxRemovePathOptions): Promise<void>;
  readonly resourceId: string;
  readonly rootPath: string;
  readonly sessionKey: string;
  spawn(options: SandboxSpawnOptions): Promise<SandboxProcess>;
  writeFiles(files: ReadonlyArray<{ path: string; content: string | Uint8Array }>): Promise<void>;
}

let justBashModulePromise: Promise<JustBashModule> | undefined;

/**
 * Loads `just-bash` from the application's own dependency tree. The
 * package is intentionally not bundled with eve — the provider is
 * opt-in — so when it is missing eve installs it into the project
 * during `eve dev` (unless `autoInstall: false`) and otherwise fails
 * with an actionable install error.
 */
async function loadJustBashModule(input: {
  readonly appRoot: string;
  readonly autoInstall: boolean;
}): Promise<JustBashModule> {
  justBashModulePromise ??= loadOptionalProviderPackage<JustBashModule>({
    appRoot: input.appRoot,
    autoInstall: input.autoInstall,
    importModule: async () => await import("just-bash"),
    missingMessage:
      "The just-bash sandbox provider requires the `just-bash` package, which is not bundled " +
      "with eve. Install it in your application (for example `pnpm add -D just-bash`), or use " +
      "DockerSandbox or DefaultSandbox instead.",
    packageName: JUST_BASH_PACKAGE_NAME,
  }).catch((error: unknown) => {
    justBashModulePromise = undefined;
    throw error;
  });
  return await justBashModulePromise;
}

export async function createBashSandbox(input: {
  readonly appRoot: string;
  readonly autoInstall: boolean;
  readonly resourceId?: string;
  readonly rootPath: string;
  readonly sessionKey: string;
}): Promise<BashSandbox> {
  const { ReadWriteFs, Sandbox } = await loadJustBashModule({
    appRoot: input.appRoot,
    autoInstall: input.autoInstall,
  });
  const filesystemRootPath = resolveLocalSandboxFilesystemRootPath(input.rootPath);
  const metadataPath = resolveLocalSandboxMetadataPath(input.rootPath);
  const metadata = await readLocalMetadata(metadataPath);
  const resourceId = input.resourceId ?? metadata?.resourceId ?? randomUUID();

  await mkdir(filesystemRootPath, { recursive: true });

  const filesystem = new ReadWriteFs({
    allowSymlinks: true,
    maxFileReadSize: Number.MAX_SAFE_INTEGER,
    root: filesystemRootPath,
  });

  await ensureLocalSandboxDirectories(filesystem);

  const sandbox = await Sandbox.create({
    cwd: WORKSPACE_ROOT,
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
        resourceId,
        version: LOCAL_SANDBOX_METADATA_VERSION,
      });
      return { resourceId, rootPath: input.rootPath };
    },
    async dispose() {
      await sandbox.stop();
    },
    async readFileBytes(path: string): Promise<Buffer | null> {
      let bytes: Uint8Array;
      try {
        bytes = await filesystem.readFileBuffer(path);
      } catch {
        return null;
      }
      return Buffer.from(bytes);
    },
    async removePath(options: SandboxRemovePathOptions): Promise<void> {
      await filesystem.rm(options.path, {
        force: options.force,
        recursive: options.recursive,
      });
    },
    resourceId,
    rootPath: input.rootPath,
    sessionKey: input.sessionKey,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      if (options.abortSignal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const wrapped =
        options.workingDirectory !== undefined
          ? `( cd ${shellQuote(options.workingDirectory)} && ${options.command} )`
          : options.command;
      // Detached execution requires object-form `runCommand`; `eval` is
      // just-bash's only way to parse an arbitrary command string there.
      const command = await sandbox.runCommand({
        args: [wrapped],
        cmd: "eval",
        detached: true,
        env: options.env,
        signal: options.abortSignal,
      });
      return adaptMultiplexedCommandToSandboxProcess({
        command,
        getOutput: (log) => log.type,
      });
    },
    async writeFiles(files) {
      for (const file of files) {
        const dir = dirname(file.path);
        await filesystem.mkdir(dir, { recursive: true });
        // Passing bytes directly avoids corrupting binary workspace assets.
        await filesystem.writeFile(file.path, file.content);
      }
    },
  };
}

/**
 * The just-bash provider cannot honor a run-time network policy: just-bash takes
 * its `NetworkConfig` only at sandbox creation (no live update) and runs no
 * `git` or other binaries, so credential brokering has nothing to act on.
 * Throw rather than silently no-op so brokering code surfaces the gap instead
 * of leaking.
 */
export async function justBashSetNetworkPolicyUnsupported(): Promise<never> {
  throw new Error(
    "setNetworkPolicy() is not supported on the just-bash sandbox provider. just-bash " +
      "applies its network policy only at sandbox creation (no run-time update) and does not run " +
      "git or other binaries. Use DockerSandbox for coarse egress control or VercelSandbox / " +
      "MicrosandboxSandbox for credential brokering.",
  );
}

export function createJustBashSandboxSession(sandbox: BashSandbox): SandboxSession {
  return buildSandboxSession(
    createFileBackedInternalSandboxSession({ id: sandbox.sessionKey, sandbox }),
    justBashSetNetworkPolicyUnsupported,
  );
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
    !isStringRecord(metadata.env) ||
    typeof metadata.resourceId !== "string"
  ) {
    return null;
  }

  return {
    env: metadata.env,
    resourceId: metadata.resourceId,
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
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
