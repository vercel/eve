import { readdir, readFile } from "node:fs/promises";
import { join, posix as pathPosix } from "node:path";

import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import { MODEL_SKILL_ROOT } from "#shared/skill-paths.js";

const RESOURCE_WORKSPACE_DIRECTORY = "workspace";
const RESOURCE_SKILLS_DIRECTORY = "skills";

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
  const entries = await readdir(sourceDirectoryPath, {
    withFileTypes: true,
  });
  const workspaceEntry = entries.find(
    (entry) => entry.name === RESOURCE_WORKSPACE_DIRECTORY && entry.isDirectory(),
  );
  const skillsEntry = entries.find(
    (entry) => entry.name === RESOURCE_SKILLS_DIRECTORY && entry.isDirectory(),
  );

  if (workspaceEntry !== undefined || skillsEntry !== undefined) {
    if (workspaceEntry !== undefined) {
      await addMaterializedDirectoryFiles({
        files,
        logicalDirectoryPath: ".",
        sourceDirectoryPath: join(sourceDirectoryPath, RESOURCE_WORKSPACE_DIRECTORY),
        targetRoot: WORKSPACE_ROOT,
      });
    }

    if (skillsEntry !== undefined) {
      await addMaterializedDirectoryFiles({
        files,
        logicalDirectoryPath: ".",
        sourceDirectoryPath: join(sourceDirectoryPath, RESOURCE_SKILLS_DIRECTORY),
        targetRoot: MODEL_SKILL_ROOT,
      });
    }
  } else {
    await addMaterializedDirectoryFiles({
      files,
      logicalDirectoryPath: ".",
      sourceDirectoryPath,
      targetRoot: WORKSPACE_ROOT,
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function addMaterializedDirectoryFiles(input: {
  readonly files: MaterializedWorkspaceFile[];
  readonly logicalDirectoryPath: string;
  readonly sourceDirectoryPath: string;
  readonly targetRoot: string;
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
        targetRoot: input.targetRoot,
      });
      continue;
    }

    input.files.push({
      content: await readFile(sourcePath),
      path: pathPosix.join(input.targetRoot, logicalPath),
    });
  }
}
