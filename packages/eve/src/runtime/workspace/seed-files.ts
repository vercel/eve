import { readdir, readFile } from "node:fs/promises";
import { join, posix as pathPosix } from "node:path";

import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

/**
 * One concrete file materialized from a workspace seed directory for
 * sandbox template preparation.
 */
interface MaterializedWorkspaceFile {
  readonly content: Buffer;
  readonly path: string;
}

/**
 * Walks a directory tree on disk and returns one entry per file rooted at
 * `/workspace/...`, sorted by path. The directory is treated as the
 * `/workspace` root for the resulting seed file paths.
 */
export async function materializeWorkspaceDirectory(
  sourceDirectoryPath: string,
): Promise<readonly MaterializedWorkspaceFile[]> {
  const files: MaterializedWorkspaceFile[] = [];
  await addMaterializedDirectoryFiles({
    files,
    logicalDirectoryPath: ".",
    sourceDirectoryPath,
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function addMaterializedDirectoryFiles(input: {
  readonly files: MaterializedWorkspaceFile[];
  readonly logicalDirectoryPath: string;
  readonly sourceDirectoryPath: string;
}): Promise<void> {
  const entries = await readdir(input.sourceDirectoryPath, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isFile()) {
      continue;
    }

    const sourcePath = join(input.sourceDirectoryPath, entry.name);
    const logicalPath = pathPosix.join(input.logicalDirectoryPath, entry.name);

    if (entry.isDirectory()) {
      await addMaterializedDirectoryFiles({
        files: input.files,
        logicalDirectoryPath: logicalPath,
        sourceDirectoryPath: sourcePath,
      });
      continue;
    }

    input.files.push({
      content: await readFile(sourcePath),
      path: pathPosix.join(WORKSPACE_ROOT, logicalPath),
    });
  }
}
