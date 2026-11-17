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
  type SandboxWorkspaceFolderSourceRef,
} from "#discover/manifest.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { collectFlatSlotCandidates, collectNamedSlotCandidates } from "#discover/slots.js";

const SANDBOX_DIRECTORY_NAME = "sandbox";

const SANDBOX_WORKSPACE_DIRECTORY_NAME = "workspace";

const SANDBOX_DEFINITION_BASE_NAME = "sandbox";

export const DISCOVER_SANDBOX_FOLDER_EMPTY = "discover/sandbox-folder-empty";

interface DiscoverSandboxSourceResult {
  diagnostics: DiscoverDiagnostic[];
  sandbox: ModuleSourceRef | null;
  sandboxWorkspace: SandboxWorkspaceFolderSourceRef | null;
}

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

  const rootCandidates = collectFlatSlotCandidates(input.rootEntries, {
    moduleBaseName: SANDBOX_DEFINITION_BASE_NAME,
  });
  if (rootCandidates.moduleFileNames.length > 0) {
    const rootFileNames = rootCandidates.moduleFileNames.map((name) => `"${name}"`).join(", ");
    diagnostics.push(
      createDiscoverErrorDiagnostic({
        code: DISCOVER_MODULE_SLOT_COLLISION,
        message:
          `Found both ${rootFileNames} and "sandbox/". ` +
          `Move ${rootFileNames} into "sandbox/sandbox.ts", or delete it if that file already exists.`,
        sourcePath: directoryPath,
      }),
    );
    return { diagnostics, sandbox: null, sandboxWorkspace: null };
  }

  const folderEntries = await readSortedDirectoryEntries(input.source, directoryPath);
  const sandboxModuleCandidates = collectFolderSandboxModuleCandidates(folderEntries);
  const workspaceFolderEntry = folderEntries.find(
    (folderEntry) =>
      folderEntry.name === SANDBOX_WORKSPACE_DIRECTORY_NAME && folderEntry.isDirectory(),
  );
  const hasDockerfile = folderEntries.some(
    (folderEntry) => folderEntry.name === "Dockerfile" && folderEntry.isFile(),
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

  if (!hasModule && !hasWorkspace && !hasDockerfile) {
    diagnostics.push(
      createDiscoverErrorDiagnostic({
        code: DISCOVER_SANDBOX_FOLDER_EMPTY,
        message:
          `Sandbox folder "sandbox/" contains no "Dockerfile", "sandbox.<ext>" definition, ` +
          `or "workspace/" subdirectory. Add one or remove the folder.`,
        sourcePath: directoryPath,
      }),
    );
    return {
      diagnostics,
      sandbox: null,
      sandboxWorkspace: null,
    };
  }

  let sandbox: ModuleSourceRef | null = null;
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

    const rootEntries = await collectWorkspaceRootEntries(input.source, workspacePath);
    sandboxWorkspace = {
      logicalPath: workspaceLogicalPath,
      rootEntries,
      sourceId: createPathDerivedSourceId(workspaceLogicalPath),
      sourcePath: workspacePath,
    };
  }

  return {
    diagnostics,
    sandbox,
    sandboxWorkspace,
  };
}

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

async function collectWorkspaceRootEntries(
  source: ProjectSource,
  workspacePath: string,
): Promise<readonly string[]> {
  const entries = await readSortedDirectoryEntries(source, workspacePath, { includeTests: true });
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
