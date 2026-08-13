import { readdir, readFile } from "node:fs/promises";
import { join, posix as pathPosix } from "node:path";

import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import { resolveSkillStoreModelRoot, type SkillStoreLocation } from "#runtime/skills/store.js";

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
 * the agent's seeded workspace root, sorted by path.
 *
 * The sandbox-owning agent seeds into the shared `/workspace`. An agent
 * with a dedicated home seeds into `{home}/workspace` instead, so its
 * authored files are additive to that agent only and never appear in
 * the tree other agents share. The live `bash` cwd stays the shared
 * `/workspace` for every agent; a homed agent reaches its seeded files
 * at `$HOME/workspace`.
 */
export async function materializeWorkspaceDirectory(
  sourceDirectoryPath: string,
  options: {
    readonly skillStoreLocation?: SkillStoreLocation;
  } = {},
): Promise<readonly MaterializedWorkspaceFile[]> {
  const workspaceSeedRoot =
    options.skillStoreLocation?.home === undefined
      ? WORKSPACE_ROOT
      : `${options.skillStoreLocation.home}/workspace`;
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
        targetRoot: workspaceSeedRoot,
      });
    }

    if (skillsEntry !== undefined) {
      await addMaterializedDirectoryFiles({
        files,
        logicalDirectoryPath: ".",
        sourceDirectoryPath: join(sourceDirectoryPath, RESOURCE_SKILLS_DIRECTORY),
        targetRoot: resolveSkillStoreModelRoot(options.skillStoreLocation ?? {}),
      });
    }
  } else {
    await addMaterializedDirectoryFiles({
      files,
      logicalDirectoryPath: ".",
      sourceDirectoryPath,
      targetRoot: workspaceSeedRoot,
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
