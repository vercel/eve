import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, posix as pathPosix, relative, resolve, sep } from "node:path";

export const WORKSPACE_RESOURCES_DIRECTORY = "workspace-resources";

const RESOURCE_WORKSPACE_DIRECTORY = "workspace";
const RESOURCE_SKILLS_DIRECTORY = "skills";

export interface WorkspaceResourceFile {
  readonly content: Uint8Array;
  readonly logicalPath: string;
}

export interface WorkspaceResourceRootIdentity {
  readonly contentHash?: string;
  readonly rootEntries: readonly string[];
}

/** Returns the one canonical compile-relative resource path for a graph node. */
export function workspaceResourceLogicalPath(nodeId: string): string {
  assertWorkspaceResourceNodeId(nodeId);
  return pathPosix.join(WORKSPACE_RESOURCES_DIRECTORY, nodeId);
}

/** Resolves one canonical node resource path and proves it stays under the compile resource root. */
export function resolveWorkspaceResourceRootPath(
  compileDirectoryPath: string,
  nodeId: string,
): string {
  const resourcesRoot = resolve(compileDirectoryPath, WORKSPACE_RESOURCES_DIRECTORY);
  const nodeRoot = resolve(compileDirectoryPath, workspaceResourceLogicalPath(nodeId));
  if (!isPathInside(resourcesRoot, nodeRoot)) {
    throw new Error(`Workspace resource node "${nodeId}" escapes the compiled resource root.`);
  }
  return nodeRoot;
}

/** Computes the canonical identity and workspace entries of one materialized node resource tree. */
export async function inspectWorkspaceResourceRoot(
  rootPath: string,
  options: { readonly resourcesRootPath?: string } = {},
): Promise<WorkspaceResourceRootIdentity> {
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Workspace resource root "${rootPath}" must be a physical directory.`);
  }
  if (options.resourcesRootPath !== undefined) {
    const resourcesRootStat = await lstat(options.resourcesRootPath);
    if (!resourcesRootStat.isDirectory() || resourcesRootStat.isSymbolicLink()) {
      throw new Error(
        `Workspace resources directory "${options.resourcesRootPath}" must be a physical directory.`,
      );
    }
    const [physicalResourcesRoot, physicalNodeRoot] = await Promise.all([
      realpath(options.resourcesRootPath),
      realpath(rootPath),
    ]);
    if (!isPathInside(physicalResourcesRoot, physicalNodeRoot)) {
      throw new Error(
        `Workspace resource root "${rootPath}" escapes physical directory "${options.resourcesRootPath}".`,
      );
    }
  }
  const rootEntries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (
      !entry.isDirectory() ||
      (entry.name !== RESOURCE_WORKSPACE_DIRECTORY && entry.name !== RESOURCE_SKILLS_DIRECTORY)
    ) {
      throw new Error(
        `Workspace resource root "${rootPath}" contains unsupported entry "${entry.name}".`,
      );
    }
  }

  const files = await listWorkspaceResourceFiles({
    logicalDirectoryPath: ".",
    sourceDirectoryPath: rootPath,
  });
  const workspace = rootEntries.find((entry) => entry.name === RESOURCE_WORKSPACE_DIRECTORY);
  return {
    contentHash: hashWorkspaceResourceFiles(
      await Promise.all(
        files.map(async (file) => ({
          content: await readFile(file.sourcePath),
          logicalPath: file.logicalPath,
        })),
      ),
    ),
    rootEntries:
      workspace === undefined
        ? []
        : renderWorkspaceRootEntries(
            await readdir(join(rootPath, RESOURCE_WORKSPACE_DIRECTORY), {
              withFileTypes: true,
            }),
          ),
  };
}

/** Hashes a canonical logical file set without depending on its storage location. */
export function hashWorkspaceResourceFiles(
  files: readonly WorkspaceResourceFile[],
): string | undefined {
  if (files.length === 0) return undefined;

  const hash = createHash("sha256");
  hash.update("eve-workspace-resource-root-v1\0");

  for (const file of [...files].sort((left, right) =>
    left.logicalPath.localeCompare(right.logicalPath),
  )) {
    hash.update(file.logicalPath);
    hash.update("\0");
    hash.update(String(file.content.byteLength));
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }

  return hash.digest("hex");
}

function assertWorkspaceResourceNodeId(nodeId: string): void {
  if (
    nodeId.length === 0 ||
    nodeId.includes("\\") ||
    nodeId.startsWith("/") ||
    nodeId.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    pathPosix.normalize(nodeId) !== nodeId
  ) {
    throw new Error(
      `Workspace resource node id "${nodeId}" must be a normalized relative POSIX path.`,
    );
  }
}

function renderWorkspaceRootEntries(entries: readonly Dirent[]): readonly string[] {
  return entries
    .map((entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      if (entry.isFile()) return entry.name;
      throw new Error(`Workspace resource tree contains unsupported entry "${entry.name}".`);
    })
    .sort((left, right) => left.localeCompare(right));
}

async function listWorkspaceResourceFiles(input: {
  readonly logicalDirectoryPath: string;
  readonly sourceDirectoryPath: string;
}): Promise<Array<{ readonly logicalPath: string; readonly sourcePath: string }>> {
  const files: Array<{ readonly logicalPath: string; readonly sourcePath: string }> = [];
  const entries = await readdir(input.sourceDirectoryPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new Error(
        `Workspace resource tree "${input.sourceDirectoryPath}" contains unsupported entry "${entry.name}".`,
      );
    }
    const sourcePath = join(input.sourceDirectoryPath, entry.name);
    const logicalPath = pathPosix.join(input.logicalDirectoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await listWorkspaceResourceFiles({
          logicalDirectoryPath: logicalPath,
          sourceDirectoryPath: sourcePath,
        })),
      );
    } else {
      files.push({ logicalPath, sourcePath });
    }
  }

  return files;
}

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}
