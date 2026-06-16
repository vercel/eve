import { join } from "node:path";

import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import {
  DISCOVER_MODULE_SLOT_COLLISION,
  DISCOVER_SANDBOX_DIRECTORY_INVALID,
  readSortedDirectoryEntries,
} from "#discover/grammar.js";
import {
  createModuleSourceRef,
  createPathDerivedSourceId,
  type SandboxSourceRef,
  type SandboxWorkspaceFolderSourceRef,
} from "#discover/manifest.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";
import { collectFlatSlotCandidates, collectNamedSlotCandidates } from "#discover/slots.js";

/**
 * Agent-root folder name that carries the optional `sandbox.<ext>`
 * override and optional `workspace/` subdirectory.
 */
const SANDBOX_DIRECTORY_NAME = "sandbox";

/**
 * Subdirectory inside the sandbox folder that mounts authored files
 * into the live sandbox cwd at session bootstrap.
 */
const SANDBOX_WORKSPACE_DIRECTORY_NAME = "workspace";

/**
 * Filename of the sandbox definition module inside the sandbox folder.
 */
const SANDBOX_DEFINITION_BASE_NAME = "sandbox";

/**
 * Discovery diagnostic emitted when the `sandbox/` folder contains an
 * authored `workspace/skills/` subtree, which is reserved for the
 * framework's skill discovery.
 */
export const DISCOVER_SANDBOX_WORKSPACE_SKILLS_RESERVED =
  "discover/sandbox-workspace-skills-reserved";

/**
 * Discovery diagnostic emitted when the `sandbox/` folder exists but
 * contains neither a `sandbox.<ext>` module nor a `workspace/`
 * subdirectory. The folder is inert and almost certainly a typo.
 */
export const DISCOVER_SANDBOX_FOLDER_EMPTY = "discover/sandbox-folder-empty";

/**
 * Result of discovering the authored sandbox from a single agent root.
 */
interface DiscoverSandboxSourceResult {
  diagnostics: DiscoverDiagnostic[];
  sandbox: SandboxSourceRef | null;
  sandboxWorkspace: SandboxWorkspaceFolderSourceRef | null;
}

/**
 * Discovers the single authored sandbox.
 *
 * Looks for `agent/sandbox/` first; the folder owns the sandbox when
 * it exists (and may carry an authored `workspace/` subtree). If no
 * folder is present, falls back to a top-level `agent/sandbox.<ext>`
 * shorthand for agents that don't need a workspace.
 */
export async function discoverSandboxSource(input: {
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
  source: ProjectSource;
}): Promise<DiscoverSandboxSourceResult> {
  const diagnostics: DiscoverDiagnostic[] = [];

  const directoryEntry = input.rootEntries.find((entry) => entry.name === SANDBOX_DIRECTORY_NAME);

  if (directoryEntry === undefined) {
    return discoverRootSandboxModule({
      diagnostics,
      rootEntries: input.rootEntries,
      rootPath: input.rootPath,
    });
  }

  const directoryPath = join(input.rootPath, SANDBOX_DIRECTORY_NAME);

  if (!directoryEntry.isDirectory()) {
    diagnostics.push(
      createDiscoverErrorDiagnostic({
        code: DISCOVER_SANDBOX_DIRECTORY_INVALID,
        message: `Expected "${directoryPath}" to be the sandbox folder.`,
        sourcePath: directoryPath,
      }),
    );
    return {
      diagnostics,
      sandbox: null,
      sandboxWorkspace: null,
    };
  }

  const folderEntries = await readSortedDirectoryEntries(input.source, directoryPath);
  const sandboxModuleCandidates = collectFolderSandboxModuleCandidates(folderEntries);
  const workspaceFolderEntry = folderEntries.find(
    (folderEntry) =>
      folderEntry.name === SANDBOX_WORKSPACE_DIRECTORY_NAME && folderEntry.isDirectory(),
  );

  if (sandboxModuleCandidates.length > 1) {
    diagnostics.push(
      createDiscoverErrorDiagnostic({
        code: DISCOVER_MODULE_SLOT_COLLISION,
        message:
          `Found multiple sandbox definition modules inside "${normalizeLogicalPath(SANDBOX_DIRECTORY_NAME)}": ` +
          sandboxModuleCandidates.map((name) => `"${name}"`).join(", "),
        sourcePath: directoryPath,
      }),
    );
    return {
      diagnostics,
      sandbox: null,
      sandboxWorkspace: null,
    };
  }

  const [moduleFileName] = sandboxModuleCandidates;
  const hasModule = moduleFileName !== undefined;
  const hasWorkspace = workspaceFolderEntry !== undefined;

  if (!hasModule && !hasWorkspace) {
    diagnostics.push(
      createDiscoverErrorDiagnostic({
        code: DISCOVER_SANDBOX_FOLDER_EMPTY,
        message:
          `Sandbox folder "sandbox/" contains neither a "sandbox.<ext>" definition ` +
          `nor a "workspace/" subdirectory. Add one or the other, or remove the folder.`,
        sourcePath: directoryPath,
      }),
    );
    return {
      diagnostics,
      sandbox: null,
      sandboxWorkspace: null,
    };
  }

  let sandbox: SandboxSourceRef | null = null;
  if (hasModule) {
    sandbox = createModuleSourceRef({
      logicalPath: join(SANDBOX_DIRECTORY_NAME, moduleFileName),
    });
  }

  let sandboxWorkspace: SandboxWorkspaceFolderSourceRef | null = null;
  if (hasWorkspace) {
    const workspacePath = join(directoryPath, SANDBOX_WORKSPACE_DIRECTORY_NAME);
    const workspaceLogicalPath = normalizeLogicalPath(
      join(SANDBOX_DIRECTORY_NAME, SANDBOX_WORKSPACE_DIRECTORY_NAME),
    );

    const reservedSkillsDiagnostic = await checkWorkspaceSkillsReservation(
      input.source,
      workspacePath,
    );
    if (reservedSkillsDiagnostic !== null) {
      diagnostics.push(reservedSkillsDiagnostic);
    } else {
      const rootEntries = await collectWorkspaceRootEntries(input.source, workspacePath);
      sandboxWorkspace = {
        logicalPath: workspaceLogicalPath,
        rootEntries,
        sourceId: createPathDerivedSourceId(workspaceLogicalPath),
        sourcePath: workspacePath,
      };
    }
  }

  return {
    diagnostics,
    sandbox,
    sandboxWorkspace,
  };
}

/**
 * Discovers a top-level `sandbox.<ext>` module when the agent has no
 * `sandbox/` folder. Provides a workspace-less shorthand for agents
 * that only need a sandbox definition; the folder layout remains
 * available whenever a `workspace/` subtree is required.
 */
function discoverRootSandboxModule(input: {
  diagnostics: DiscoverDiagnostic[];
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
}): DiscoverSandboxSourceResult {
  const candidates = collectFlatSlotCandidates(input.rootEntries, {
    moduleBaseName: SANDBOX_DEFINITION_BASE_NAME,
  });

  if (candidates.moduleFileNames.length > 1) {
    input.diagnostics.push(
      createDiscoverErrorDiagnostic({
        code: DISCOVER_MODULE_SLOT_COLLISION,
        message:
          `Found multiple top-level sandbox definition modules: ` +
          candidates.moduleFileNames.map((name) => `"${name}"`).join(", "),
        sourcePath: input.rootPath,
      }),
    );
    return {
      diagnostics: input.diagnostics,
      sandbox: null,
      sandboxWorkspace: null,
    };
  }

  const [moduleFileName] = candidates.moduleFileNames;

  if (moduleFileName === undefined) {
    return {
      diagnostics: input.diagnostics,
      sandbox: null,
      sandboxWorkspace: null,
    };
  }

  return {
    diagnostics: input.diagnostics,
    sandbox: createModuleSourceRef({
      logicalPath: moduleFileName,
    }),
    sandboxWorkspace: null,
  };
}

/**
 * Returns the file names inside the sandbox folder that match the
 * `sandbox.<ext>` definition slot. The result is sorted for stable
 * collision diagnostics.
 */
function collectFolderSandboxModuleCandidates(
  entries: readonly ProjectSourceEntry[],
): readonly string[] {
  const moduleEntries = entries.filter((entry) => entry.isFile());
  const candidates: string[] = [];

  for (const candidate of collectNamedSlotCandidates(moduleEntries, {
    allowMarkdown: false,
    allowModules: true,
  })) {
    if (candidate.slotName === SANDBOX_DEFINITION_BASE_NAME) {
      candidates.push(...candidate.moduleFileNames);
    }
  }

  return candidates;
}

/**
 * Walks the top of an authored workspace folder and returns the
 * file/directory names ordered alphabetically. Directories are
 * suffixed with `/` so the workspace prompt section can render them
 * recognizably.
 */
async function collectWorkspaceRootEntries(
  source: ProjectSource,
  workspacePath: string,
): Promise<readonly string[]> {
  const entries = await readSortedDirectoryEntries(source, workspacePath);
  const rendered: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      rendered.push(`${entry.name}/`);
      continue;
    }

    if (entry.isFile()) {
      rendered.push(entry.name);
    }
  }

  return rendered;
}

/**
 * Returns a diagnostic when the sandbox workspace folder declares a
 * `skills/` subtree, since that path is reserved for the framework's
 * skill discovery.
 */
async function checkWorkspaceSkillsReservation(
  source: ProjectSource,
  workspacePath: string,
): Promise<DiscoverDiagnostic | null> {
  const entries = await readSortedDirectoryEntries(source, workspacePath);
  const skillsEntry = entries.find((entry) => entry.name === "skills");

  if (skillsEntry === undefined) {
    return null;
  }

  return createDiscoverErrorDiagnostic({
    code: DISCOVER_SANDBOX_WORKSPACE_SKILLS_RESERVED,
    message:
      `"sandbox/workspace/skills/" is reserved for the framework skill discovery. ` +
      `Move skill files under "agent/skills/" instead, or rename the subtree.`,
    sourcePath: join(workspacePath, "skills"),
  });
}
