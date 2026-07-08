import { randomUUID } from "node:crypto";
import { access, cp, mkdir, rename, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

import { bufferToStream, streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import { resolveSandboxSeedFilePath } from "#shared/skill-paths.js";
import type { SandboxSeedFile } from "#shared/sandbox-backend.js";
import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxRemovePathOptions,
  SandboxSession,
  SandboxSpawnOptions,
} from "#shared/sandbox-session.js";

export interface FileBackedSandbox {
  readFileBytes(path: string): Promise<Buffer | null>;
  removePath(options: SandboxRemovePathOptions): Promise<void>;
  spawn(options: SandboxSpawnOptions): Promise<SandboxProcess>;
  writeFiles(
    files: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array }>,
  ): Promise<void>;
}

export function createFileBackedInternalSandboxSession(input: {
  readonly id: string;
  readonly sandbox: FileBackedSandbox;
}): InternalSandboxSession {
  return {
    id: input.id,
    resolvePath: resolveWorkspacePath,
    async spawn(options: SandboxSpawnOptions) {
      return await input.sandbox.spawn(options);
    },
    async readFile(options) {
      const buf = await input.sandbox.readFileBytes(options.path);
      return buf === null ? null : bufferToStream(buf);
    },
    async removePath(options: SandboxRemovePathOptions) {
      await input.sandbox.removePath(options);
    },
    async writeFile(options) {
      const buf = await streamToBuffer(options.content);
      await input.sandbox.writeFiles([{ content: buf, path: options.path }]);
    },
  };
}

export function resolveWorkspacePath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${WORKSPACE_ROOT}/${path}`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function copyDirectoryAtomically(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const temporaryTargetPath = `${targetPath}.${randomUUID()}.tmp`;

  await rm(temporaryTargetPath, { force: true, recursive: true });
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await cp(sourcePath, temporaryTargetPath, { recursive: true });
    await rename(temporaryTargetPath, targetPath);
  } catch (error) {
    await rm(temporaryTargetPath, { force: true, recursive: true }).catch(() => {});
    if (await pathExists(targetPath)) {
      return;
    }
    throw error;
  }
}

export async function touchDirectory(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, now);
}

export function resolveLocalBackendTemplateRootPath(
  cacheDirectory: string,
  backendCacheName: string,
  templateKey: string,
): string {
  return join(resolveLocalBackendTemplatesDirectory(cacheDirectory, backendCacheName), templateKey);
}

export function resolveLocalBackendTemplatesDirectory(
  cacheDirectory: string,
  backendCacheName: string,
): string {
  return join(cacheDirectory, backendCacheName, "templates");
}

export function resolveLocalBackendSessionRootPath(
  cacheDirectory: string,
  backendCacheName: string,
  sessionKey: string,
): string {
  return join(cacheDirectory, backendCacheName, "sessions", sessionKey);
}

export async function writeSandboxSeedFiles(
  session: SandboxSession,
  seedFiles: ReadonlyArray<SandboxSeedFile>,
): Promise<void> {
  for (const file of seedFiles) {
    const path = await resolveSandboxSeedFilePath({
      path: file.path,
      sandbox: session,
    });

    if (typeof file.content === "string") {
      await session.writeTextFile({ content: file.content, path });
    } else {
      await session.writeBinaryFile({ content: file.content, path });
    }
  }
}
