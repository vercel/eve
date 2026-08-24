import { join, relative, resolve } from "node:path";

import { lowerSkillMarkdown } from "#internal/helpers/markdown.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  createCompilerErrorDiagnostic,
  type CompilerDiagnostic,
} from "#shared/compiler-diagnostics.js";
import {
  classifySkillPackageEntry,
  classifySkillsDirectoryEntry,
  getDirectoryEntryType,
  getSupportedModuleBaseName,
  normalizeLogicalPath,
} from "#discover/filesystem.js";
import { readSortedDirectoryEntries } from "#discover/grammar.js";
import {
  createModuleSourceRef,
  createPathDerivedSourceId,
  createSkillPackageSourceRef,
  type SkillSourceRef,
} from "#discover/manifest.js";
import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";

/**
 * Diagnostics emitted by skill discovery.
 */
export const DISCOVER_SKILLS_DIRECTORY_INVALID = "discover/skills-directory-invalid";
export const DISCOVER_SKILL_COLLISION = "discover/skill-collision";
export const DISCOVER_SKILL_ENTRY_NOT_DIRECTORY = "discover/skill-entry-not-directory";
export const DISCOVER_SKILL_FRONTMATTER_INVALID = "discover/skill-frontmatter-invalid";
export const DISCOVER_SKILL_MARKDOWN_MISSING = "discover/skill-markdown-missing";

/**
 * Input for discovering authored skills.
 */
interface DiscoverSkillsInput {
  agentRoot: string;
  nodeId: string;
  /**
   * Optional {@link ProjectSource} used for all filesystem reads. Defaults to
   * a disk-backed source so disk callers keep their current behaviour.
   */
  source?: ProjectSource;
  skillsDirectoryPath?: string;
  skillsLogicalPath?: string;
}

/**
 * Result of discovering authored skills.
 */
interface DiscoverSkillsResult {
  diagnostics: CompilerDiagnostic[];
  skills: SkillSourceRef[];
}

/**
 * Discovers authored skills from either flat
 * `skills/<name>.md|ts|cts|mts|js|cjs|mjs`
 * entries or Agent Skills packages rooted at `skills/<name>/SKILL.md`.
 */
export async function discoverSkills(input: DiscoverSkillsInput): Promise<DiscoverSkillsResult> {
  const { nodeId } = input;
  const source = input.source ?? createDiskProjectSource();
  const agentRoot = resolve(input.agentRoot);
  const skillsDirectoryPath = resolve(input.skillsDirectoryPath ?? join(agentRoot, "skills"));
  const skillsLogicalPath = normalizeLogicalPath(
    input.skillsLogicalPath ?? relative(agentRoot, skillsDirectoryPath),
  );
  const skillsDirectoryType = await source.stat(skillsDirectoryPath);

  if (skillsDirectoryType === "missing") {
    return {
      diagnostics: [],
      skills: [],
    };
  }

  if (skillsDirectoryType !== "directory") {
    return {
      diagnostics: [
        createCompilerErrorDiagnostic({
          code: DISCOVER_SKILLS_DIRECTORY_INVALID,
          message: `Expected "${skillsDirectoryPath}" to be a directory of authored skills.`,
          nodeId,
          sourcePath: skillsDirectoryPath,
        }),
      ],
      skills: [],
    };
  }

  const diagnostics: CompilerDiagnostic[] = [];
  const collidedSkillIds = new Set<string>();
  const skillsById = new Map<
    string,
    {
      logicalPath: string;
      skill: SkillSourceRef;
    }
  >();
  const entries = await readSortedDirectoryEntries(source, skillsDirectoryPath);

  for (const entry of entries) {
    const discoveredSkill = await discoverOneSkill({
      entryName: entry.name,
      entryType: getDirectoryEntryType(entry),
      nodeId,
      skillsDirectoryPath,
      skillsLogicalPath,
      source,
    });

    diagnostics.push(...discoveredSkill.diagnostics);

    if (discoveredSkill.skill === null || discoveredSkill.skillId === null) {
      continue;
    }

    if (collidedSkillIds.has(discoveredSkill.skillId)) {
      continue;
    }

    const existingSkill = skillsById.get(discoveredSkill.skillId);

    if (existingSkill !== undefined) {
      diagnostics.push(
        createCompilerErrorDiagnostic({
          code: DISCOVER_SKILL_COLLISION,
          message: `Found conflicting authored skill sources for "${discoveredSkill.skillId}": "${existingSkill.logicalPath}" and "${discoveredSkill.logicalPath}".`,
          nodeId,
          sourcePath: join(skillsDirectoryPath, discoveredSkill.skillId),
        }),
      );
      collidedSkillIds.add(discoveredSkill.skillId);
      skillsById.delete(discoveredSkill.skillId);
      continue;
    }

    skillsById.set(discoveredSkill.skillId, {
      logicalPath: discoveredSkill.logicalPath,
      skill: discoveredSkill.skill,
    });
  }

  return {
    diagnostics,
    skills: [...skillsById.values()].map((entry) => entry.skill),
  };
}

async function discoverOneSkill(input: {
  entryName: string;
  entryType: "directory" | "file" | "other";
  nodeId: string;
  skillsDirectoryPath: string;
  skillsLogicalPath: string;
  source: ProjectSource;
}): Promise<{
  diagnostics: CompilerDiagnostic[];
  logicalPath: string;
  skill: SkillSourceRef | null;
  skillId: string | null;
}> {
  const entryPath = join(input.skillsDirectoryPath, input.entryName);

  switch (classifySkillsDirectoryEntry(input.entryName, input.entryType)) {
    case "skill-package-directory":
      return discoverPackagedSkill({
        logicalSkillsPath: input.skillsLogicalPath,
        nodeId: input.nodeId,
        skillId: input.entryName,
        skillRootPath: entryPath,
        source: input.source,
      });
    case "flat-skill-markdown":
      return discoverFlatMarkdownSkill({
        logicalSkillsPath: input.skillsLogicalPath,
        nodeId: input.nodeId,
        skillFileName: input.entryName,
        skillFilePath: entryPath,
        source: input.source,
      });
    case "flat-skill-module":
      return discoverFlatModuleSkill({
        logicalSkillsPath: input.skillsLogicalPath,
        skillFileName: input.entryName,
      });
    case "ignored-declaration":
      return {
        diagnostics: [],
        logicalPath: normalizeLogicalPath(join(input.skillsLogicalPath, input.entryName)),
        skill: null,
        skillId: null,
      };
    default:
      return {
        diagnostics: [
          createCompilerErrorDiagnostic({
            code: DISCOVER_SKILL_ENTRY_NOT_DIRECTORY,
            message: `Expected "${entryPath}" to be a skill directory containing SKILL.md or a flat ".md", ".ts", ".cts", ".mts", ".js", ".cjs", or ".mjs" skill file.`,
            nodeId: input.nodeId,
            sourcePath: entryPath,
          }),
        ],
        logicalPath: normalizeLogicalPath(join(input.skillsLogicalPath, input.entryName)),
        skill: null,
        skillId: null,
      };
  }
}

async function discoverPackagedSkill(input: {
  logicalSkillsPath: string;
  nodeId: string;
  skillId: string;
  skillRootPath: string;
  source: ProjectSource;
}): Promise<{
  diagnostics: CompilerDiagnostic[];
  logicalPath: string;
  skill: SkillSourceRef | null;
  skillId: string | null;
}> {
  const entries = await readSortedDirectoryEntries(input.source, input.skillRootPath);
  const skillFileName = entries.find(
    (entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md",
  )?.name;
  const skillFilePath = join(input.skillRootPath, skillFileName ?? "SKILL.md");
  const logicalPath = normalizeLogicalPath(
    join(input.logicalSkillsPath, input.skillId, skillFileName ?? "SKILL.md"),
  );

  if (skillFileName === undefined) {
    return {
      diagnostics: [
        createCompilerErrorDiagnostic({
          code: DISCOVER_SKILL_MARKDOWN_MISSING,
          message: `Expected "${skillFilePath}" to exist for the "${input.skillId}" skill.`,
          nodeId: input.nodeId,
          sourcePath: input.skillRootPath,
        }),
      ],
      logicalPath,
      skill: null,
      skillId: null,
    };
  }

  let definition: ReturnType<typeof lowerSkillMarkdown>;

  try {
    definition = lowerSkillMarkdown(await input.source.readTextFile(skillFilePath));
  } catch (error) {
    return {
      diagnostics: [
        createCompilerErrorDiagnostic({
          code: DISCOVER_SKILL_FRONTMATTER_INVALID,
          message: formatSkillDiscoveryError(skillFilePath, error),
          nodeId: input.nodeId,
          sourcePath: skillFilePath,
        }),
      ],
      logicalPath,
      skill: null,
      skillId: null,
    };
  }

  const packagePaths = await discoverSkillPackagePaths(input.source, input.skillRootPath);
  const skillSourceRefInput: {
    assetsPath?: string;
    description: string;
    license?: string;
    logicalPath: string;
    markdown: string;
    metadata?: Readonly<Record<string, string>>;
    name: string;
    referencesPath?: string;
    rootPath: string;
    scriptsPath?: string;
    skillFilePath: string;
    skillId: string;
    sourceId: string;
  } = {
    description: definition.description,
    logicalPath,
    markdown: definition.markdown,
    name: input.skillId,
    rootPath: input.skillRootPath,
    skillFilePath,
    skillId: input.skillId,
    sourceId: createPathDerivedSourceId(logicalPath),
  };

  if (packagePaths.assetsPath !== undefined) {
    skillSourceRefInput.assetsPath = packagePaths.assetsPath;
  }

  if (definition.license !== undefined) {
    skillSourceRefInput.license = definition.license;
  }

  if (definition.metadata !== undefined) {
    skillSourceRefInput.metadata = definition.metadata;
  }

  if (packagePaths.referencesPath !== undefined) {
    skillSourceRefInput.referencesPath = packagePaths.referencesPath;
  }

  if (packagePaths.scriptsPath !== undefined) {
    skillSourceRefInput.scriptsPath = packagePaths.scriptsPath;
  }

  return {
    diagnostics: [],
    logicalPath,
    skill: createSkillPackageSourceRef(skillSourceRefInput),
    skillId: input.skillId,
  };
}

async function discoverFlatMarkdownSkill(input: {
  logicalSkillsPath: string;
  nodeId: string;
  skillFileName: string;
  skillFilePath: string;
  source: ProjectSource;
}): Promise<{
  diagnostics: CompilerDiagnostic[];
  logicalPath: string;
  skill: SkillSourceRef | null;
  skillId: string | null;
}> {
  const skillId = stripMarkdownExtension(input.skillFileName);
  const logicalPath = normalizeLogicalPath(join(input.logicalSkillsPath, input.skillFileName));
  let definition: ReturnType<typeof lowerSkillMarkdown>;

  try {
    definition = lowerSkillMarkdown(await input.source.readTextFile(input.skillFilePath), {
      slug: skillId,
    });
  } catch (error) {
    return {
      diagnostics: [
        createCompilerErrorDiagnostic({
          code: DISCOVER_SKILL_FRONTMATTER_INVALID,
          message: formatSkillDiscoveryError(input.skillFilePath, error),
          nodeId: input.nodeId,
          sourcePath: input.skillFilePath,
        }),
      ],
      logicalPath,
      skill: null,
      skillId: null,
    };
  }

  return {
    diagnostics: [],
    logicalPath,
    skill: {
      definition,
      sourceKind: "markdown",
      logicalPath,
      sourceId: createPathDerivedSourceId(logicalPath),
    },
    skillId,
  };
}

async function discoverFlatModuleSkill(input: {
  logicalSkillsPath: string;
  skillFileName: string;
}): Promise<{
  diagnostics: CompilerDiagnostic[];
  logicalPath: string;
  skill: SkillSourceRef | null;
  skillId: string | null;
}> {
  const skillId = getSupportedModuleBaseName(input.skillFileName);
  const logicalPath = normalizeLogicalPath(join(input.logicalSkillsPath, input.skillFileName));

  if (skillId === null) {
    return {
      diagnostics: [],
      logicalPath,
      skill: null,
      skillId: null,
    };
  }

  return {
    diagnostics: [],
    logicalPath,
    skill: createModuleSourceRef({
      logicalPath,
    }),
    skillId,
  };
}

async function discoverSkillPackagePaths(
  source: ProjectSource,
  skillRootPath: string,
): Promise<{
  assetsPath?: string;
  referencesPath?: string;
  scriptsPath?: string;
}> {
  const entries = await source.readDirectory(skillRootPath);
  const packagePaths: {
    assetsPath?: string;
    referencesPath?: string;
    scriptsPath?: string;
  } = {};

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    switch (classifySkillPackageEntry(entry.name, getDirectoryEntryType(entry))) {
      case "skill-assets-directory":
        packagePaths.assetsPath = join(skillRootPath, entry.name);
        break;
      case "skill-references-directory":
        packagePaths.referencesPath = join(skillRootPath, entry.name);
        break;
      case "skill-scripts-directory":
        packagePaths.scriptsPath = join(skillRootPath, entry.name);
        break;
      default:
        break;
    }
  }

  return packagePaths;
}

function formatSkillDiscoveryError(skillFilePath: string, error: unknown): string {
  return `Invalid authored skill frontmatter in "${skillFilePath}": ${toErrorMessage(error)}`;
}

function stripMarkdownExtension(input: string): string {
  return input.toLowerCase().endsWith(".md") ? input.slice(0, -".md".length) : input;
}
