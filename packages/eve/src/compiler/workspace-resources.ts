import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, posix as pathPosix } from "node:path";

import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledSkillDefinition,
  CompiledWorkspaceResourceRoot,
} from "#compiler/manifest.js";
import { deriveResourceRootEntries, ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import { normalizeSkillPackage, writeSkillPackageDirectory } from "#shared/skill-package.js";

const RESOURCES_DIRECTORY = "workspace-resources";

/**
 * Materializes the per-node workspace resource trees under
 * `.eve/compile/workspace-resources/` and returns a manifest whose node
 * descriptors point at the freshly-written directories.
 *
 * Idempotent against an existing compile run: the resources directory
 * is removed before each invocation so a re-compile produces a clean
 * tree.
 */
export async function materializeWorkspaceResources(input: {
  readonly compileDirectoryPath: string;
  readonly manifest: CompiledAgentManifest;
}): Promise<CompiledAgentManifest> {
  const resourcesRoot = join(input.compileDirectoryPath, RESOURCES_DIRECTORY);
  await rm(resourcesRoot, { force: true, recursive: true });

  const rootAgent = await materializeNode({
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    resourcesRoot,
    manifest: input.manifest,
  });
  const subagents = await Promise.all(
    input.manifest.subagents.map(async (subagent) => ({
      ...subagent,
      agent: await materializeNode({
        nodeId: subagent.nodeId,
        resourcesRoot,
        manifest: subagent.agent,
      }),
    })),
  );

  return {
    ...rootAgent,
    kind: input.manifest.kind,
    subagentEdges: input.manifest.subagentEdges,
    subagents,
    version: input.manifest.version,
  };
}

function createResourceRoot(
  manifest: CompiledAgentNodeManifest,
  nodeId: string,
  contentHash: string,
): CompiledWorkspaceResourceRoot {
  return {
    contentHash,
    logicalPath: normalizeLogicalPath(join(RESOURCES_DIRECTORY, nodeId)),
    rootEntries: deriveResourceRootEntries({
      sandboxWorkspaces: manifest.sandboxWorkspaces,
      skills: manifest.skills,
    }),
  };
}

async function materializeNode(input: {
  readonly manifest: CompiledAgentNodeManifest;
  readonly nodeId: string;
  readonly resourcesRoot: string;
}): Promise<CompiledAgentNodeManifest> {
  // Validate up-front so a `skills/`-shadowing workspace doesn't leave
  // partial output behind from earlier workspaces in the same node.
  for (const workspace of input.manifest.sandboxWorkspaces) {
    if (workspace.rootEntries.some((entry) => entry === "skills/" || entry === "skills")) {
      throw new Error(
        `Sandbox workspace "${workspace.logicalPath}" cannot define "skills" because eve manages that workspace entry.`,
      );
    }
  }

  const nodeRoot = join(input.resourcesRoot, input.nodeId);
  await mkdir(nodeRoot, { recursive: true });

  for (const workspace of input.manifest.sandboxWorkspaces) {
    await cp(workspace.sourcePath, nodeRoot, { recursive: true });
  }

  for (const skill of input.manifest.skills) {
    await materializeSkill({ nodeRoot, skill });
  }

  const contentHash = await hashWorkspaceResourceRoot(nodeRoot);

  return {
    ...input.manifest,
    skills: input.manifest.skills.map(stripSkillPackageFiles),
    workspaceResourceRoot: createResourceRoot(input.manifest, input.nodeId, contentHash),
  };
}

async function materializeSkill(input: {
  readonly nodeRoot: string;
  readonly skill: CompiledSkillDefinition;
}): Promise<void> {
  const skillRoot = join(input.nodeRoot, "skills", input.skill.name);

  if (input.skill.sourceKind === "skill-package") {
    await cp(input.skill.rootPath, skillRoot, { recursive: true });
    return;
  }

  await writeSkillPackageDirectory({
    rootPath: input.nodeRoot,
    skill: normalizeSkillPackage(input.skill),
  });
}

function stripSkillPackageFiles(skill: CompiledSkillDefinition): CompiledSkillDefinition {
  const { files: _files, ...manifestSkill } = skill;
  return manifestSkill;
}

async function hashWorkspaceResourceRoot(rootPath: string): Promise<string> {
  const files = await listWorkspaceResourceFiles({
    logicalDirectoryPath: ".",
    sourceDirectoryPath: rootPath,
  });
  files.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));

  const hash = createHash("sha256");
  hash.update("eve-workspace-resource-root-v1\0");

  for (const file of files) {
    const content = await readFile(file.sourcePath);
    hash.update(file.logicalPath);
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function listWorkspaceResourceFiles(input: {
  readonly logicalDirectoryPath: string;
  readonly sourceDirectoryPath: string;
}): Promise<Array<{ readonly logicalPath: string; readonly sourcePath: string }>> {
  const files: Array<{ readonly logicalPath: string; readonly sourcePath: string }> = [];
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
      files.push(
        ...(await listWorkspaceResourceFiles({
          logicalDirectoryPath: logicalPath,
          sourceDirectoryPath: sourcePath,
        })),
      );
      continue;
    }

    files.push({ logicalPath, sourcePath });
  }

  return files;
}
