import { readdir, readFile } from "node:fs/promises";
import { join, posix as pathPosix } from "node:path";

import type { SandboxProviderResourceFile } from "#shared/sandbox-provider.js";

const RESOURCE_WORKSPACE_DIRECTORY = "workspace";
const RESOURCE_SKILLS_DIRECTORY = "skills";

/** The files of one resource directory, split into the trees sandbox providers receive. */
export interface MaterializedResourceTrees {
  readonly skills: readonly SandboxProviderResourceFile[];
  readonly workspace: readonly SandboxProviderResourceFile[];
}

/**
 * Reads a compiled resource directory into its `workspace/` and `skills/`
 * trees, each sorted by relative path. A directory with neither subdirectory
 * is read as the workspace tree itself.
 */
export async function materializeWorkspaceDirectory(
  sourceDirectoryPath: string,
): Promise<MaterializedResourceTrees> {
  const entries = await readdir(sourceDirectoryPath, {
    withFileTypes: true,
  });
  const hasDirectory = (name: string) =>
    entries.some((entry) => entry.name === name && entry.isDirectory());
  const hasWorkspace = hasDirectory(RESOURCE_WORKSPACE_DIRECTORY);
  const hasSkills = hasDirectory(RESOURCE_SKILLS_DIRECTORY);

  if (!hasWorkspace && !hasSkills) {
    return { skills: [], workspace: await readResourceTree(sourceDirectoryPath) };
  }
  return {
    skills: hasSkills
      ? await readResourceTree(join(sourceDirectoryPath, RESOURCE_SKILLS_DIRECTORY))
      : [],
    workspace: hasWorkspace
      ? await readResourceTree(join(sourceDirectoryPath, RESOURCE_WORKSPACE_DIRECTORY))
      : [],
  };
}

async function readResourceTree(rootPath: string): Promise<SandboxProviderResourceFile[]> {
  const files: SandboxProviderResourceFile[] = [];
  await addResourceFiles({ files, relativeDirectoryPath: ".", sourceDirectoryPath: rootPath });
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

async function addResourceFiles(input: {
  readonly files: SandboxProviderResourceFile[];
  readonly relativeDirectoryPath: string;
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
    const relativePath = pathPosix.join(input.relativeDirectoryPath, entry.name);

    if (entry.isDirectory()) {
      await addResourceFiles({
        files: input.files,
        relativeDirectoryPath: relativePath,
        sourceDirectoryPath: sourcePath,
      });
      continue;
    }

    input.files.push({
      content: await readFile(sourcePath),
      relativePath,
    });
  }
}
