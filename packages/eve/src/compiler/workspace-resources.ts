import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, posix as pathPosix, resolve } from "node:path";

import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledSkillDefinition,
  CompiledWorkspaceResourceRoot,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { normalizeSkillPackage, writeSkillPackageDirectory } from "#shared/skill-package.js";
import {
  hashWorkspaceResourceFiles,
  inspectWorkspaceResourceRoot,
  resolveWorkspaceResourceRootPath,
  WORKSPACE_RESOURCES_DIRECTORY,
  workspaceResourceLogicalPath,
} from "#shared/workspace-resource-identity.js";

const RESOURCE_WORKSPACE_DIRECTORY = "workspace";
const RESOURCE_SKILLS_DIRECTORY = "skills";

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
  const resourcesRoot = resolve(input.compileDirectoryPath, WORKSPACE_RESOURCES_DIRECTORY);
  await rm(resourcesRoot, { force: true, recursive: true });

  const rootAgent = await materializeNode({
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    compileDirectoryPath: input.compileDirectoryPath,
    manifest: input.manifest,
  });
  const subagents = await Promise.all(
    input.manifest.subagents.map(async (subagent) => {
      if (subagent.configResolver === undefined) {
        return {
          ...subagent,
          agent: await materializeNode({
            nodeId: subagent.nodeId,
            compileDirectoryPath: input.compileDirectoryPath,
            manifest: subagent.agent,
          }),
        };
      }
      return {
        ...subagent,
        agent: await materializeNode({
          nodeId: subagent.nodeId,
          compileDirectoryPath: input.compileDirectoryPath,
          manifest: subagent.agent,
        }),
        configResolver: subagent.configResolver,
      };
    }),
  );

  return {
    ...rootAgent,
    kind: input.manifest.kind,
    extensionMounts: input.manifest.extensionMounts,
    subagentEdges: input.manifest.subagentEdges,
    subagents,
    version: input.manifest.version,
  };
}

/**
 * Finalizes the byte-free resource descriptor for an in-memory compilation.
 * Programmatic fixtures have no discovered workspace directory, so their
 * managed resource payload consists only of normalized static skill files.
 */
export function finalizeProgrammaticWorkspaceResources(input: {
  readonly manifest: CompiledAgentManifest;
}): CompiledAgentManifest {
  const rootAgent = finalizeProgrammaticNode({
    manifest: input.manifest,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
  });
  const subagents = input.manifest.subagents.map((subagent) => {
    if (subagent.configResolver === undefined) {
      return {
        ...subagent,
        agent: finalizeProgrammaticNode<CompiledAgentNodeManifest>({
          manifest: subagent.agent,
          nodeId: subagent.nodeId,
        }),
      };
    }
    return {
      ...subagent,
      agent: finalizeProgrammaticNode<CompiledAgentResources>({
        manifest: subagent.agent,
        nodeId: subagent.nodeId,
      }),
      configResolver: subagent.configResolver,
    };
  });

  return {
    ...rootAgent,
    kind: input.manifest.kind,
    extensionMounts: input.manifest.extensionMounts,
    subagentEdges: input.manifest.subagentEdges,
    subagents,
    version: input.manifest.version,
  };
}

function createResourceRoot(
  nodeId: string,
  contentHash: string | undefined,
  rootEntries: readonly string[],
): CompiledWorkspaceResourceRoot {
  return {
    contentHash,
    logicalPath: workspaceResourceLogicalPath(nodeId),
    rootEntries,
  };
}

async function materializeNode<TManifest extends CompiledAgentResources>(input: {
  readonly compileDirectoryPath: string;
  readonly manifest: TManifest;
  readonly nodeId: string;
}): Promise<TManifest> {
  const nodeRoot = resolveWorkspaceResourceRootPath(input.compileDirectoryPath, input.nodeId);
  await mkdir(nodeRoot, { recursive: true });

  const workspaceRoot = join(nodeRoot, RESOURCE_WORKSPACE_DIRECTORY);
  for (const workspace of input.manifest.sandboxWorkspaces) {
    await copyDirectoryContents({
      sourcePath: workspace.sourcePath,
      targetPath: workspaceRoot,
    });
  }

  for (const skill of input.manifest.skills) {
    await materializeSkill({ nodeRoot, skill });
  }

  const identity = await inspectWorkspaceResourceRoot(nodeRoot, {
    resourcesRootPath: resolve(input.compileDirectoryPath, WORKSPACE_RESOURCES_DIRECTORY),
  });

  return {
    ...input.manifest,
    skills: input.manifest.skills.map(stripSkillPackageFiles),
    workspaceResourceRoot: createResourceRoot(
      input.nodeId,
      identity.contentHash,
      identity.rootEntries,
    ),
  };
}

function finalizeProgrammaticNode<TManifest extends CompiledAgentResources>(input: {
  readonly manifest: TManifest;
  readonly nodeId: string;
}): TManifest {
  if (input.manifest.sandboxWorkspaces.length > 0) {
    throw new Error(
      `Cannot finalize programmatic workspace resources for node "${input.nodeId}" with filesystem workspace sources.`,
    );
  }

  const files = input.manifest.skills.flatMap((skill) => {
    if (skill.sourceKind === "skill-package") {
      throw new Error(
        `Cannot finalize filesystem skill package "${skill.logicalPath}" as a programmatic workspace resource.`,
      );
    }
    return normalizeSkillPackage(skill).files.map((file) => ({
      content: file.content,
      logicalPath: pathPosix.join(RESOURCE_SKILLS_DIRECTORY, skill.name, file.relativePath),
    }));
  });

  return {
    ...input.manifest,
    skills: input.manifest.skills.map(stripSkillPackageFiles),
    workspaceResourceRoot: createResourceRoot(input.nodeId, hashWorkspaceResourceFiles(files), []),
  };
}

async function materializeSkill(input: {
  readonly nodeRoot: string;
  readonly skill: CompiledSkillDefinition;
}): Promise<void> {
  const skillRoot = join(input.nodeRoot, RESOURCE_SKILLS_DIRECTORY, input.skill.name);

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

async function copyDirectoryContents(input: {
  readonly sourcePath: string;
  readonly targetPath: string;
}): Promise<void> {
  const entries = await readdir(input.sourcePath, {
    withFileTypes: true,
  });

  await mkdir(input.targetPath, { recursive: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isFile()) {
      continue;
    }

    await cp(join(input.sourcePath, entry.name), join(input.targetPath, entry.name), {
      recursive: true,
    });
  }
}
