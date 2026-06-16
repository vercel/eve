import type { Dirent } from "node:fs";

import { getSupportedModuleBaseName } from "#discover/filesystem.js";

/**
 * Candidate authored sources for one flat slot such as `system` or `agent`.
 */
interface FlatSlotCandidates {
  markdownFileName?: string;
  moduleFileNames: string[];
}

/**
 * Candidate authored sources for one named directory slot such as
 * `tools/<name>`.
 */
interface NamedSlotCandidates extends FlatSlotCandidates {
  slotName: string;
}

/**
 * Collects markdown and module candidates for one flat slot in one directory.
 */
export function collectFlatSlotCandidates(
  entries: readonly Pick<Dirent<string>, "isFile" | "name">[],
  input: {
    markdownFileName?: string;
    moduleBaseName?: string;
  },
): FlatSlotCandidates {
  const candidates: FlatSlotCandidates = {
    moduleFileNames: [],
  };

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (
      input.markdownFileName !== undefined &&
      entry.name.toLowerCase() === input.markdownFileName.toLowerCase()
    ) {
      candidates.markdownFileName = entry.name;
      continue;
    }

    if (
      input.moduleBaseName !== undefined &&
      getSupportedModuleBaseName(entry.name) === input.moduleBaseName
    ) {
      candidates.moduleFileNames.push(entry.name);
    }
  }

  candidates.moduleFileNames.sort((left, right) => left.localeCompare(right));

  return candidates;
}

/**
 * Groups markdown and module candidates for directory-backed named slots.
 */
export function collectNamedSlotCandidates(
  entries: readonly Pick<Dirent<string>, "isFile" | "name">[],
  input: {
    allowMarkdown: boolean;
    allowModules: boolean;
  },
): NamedSlotCandidates[] {
  const candidatesBySlotName = new Map<string, NamedSlotCandidates>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const markdownSlotName = input.allowMarkdown ? getMarkdownSlotName(entry.name) : null;
    const moduleSlotName = input.allowModules ? getSupportedModuleBaseName(entry.name) : null;
    const slotName = markdownSlotName ?? moduleSlotName;

    if (slotName === null) {
      continue;
    }

    let slotCandidates = candidatesBySlotName.get(slotName);

    if (slotCandidates === undefined) {
      slotCandidates = {
        moduleFileNames: [],
        slotName,
      };
      candidatesBySlotName.set(slotName, slotCandidates);
    }

    if (markdownSlotName !== null) {
      slotCandidates.markdownFileName = entry.name;
      continue;
    }

    if (moduleSlotName !== null) {
      slotCandidates.moduleFileNames.push(entry.name);
    }
  }

  return [...candidatesBySlotName.values()]
    .map((slotCandidates) => {
      slotCandidates.moduleFileNames.sort((left, right) => left.localeCompare(right));
      return slotCandidates;
    })
    .sort((left, right) => left.slotName.localeCompare(right.slotName));
}

function getMarkdownSlotName(name: string): string | null {
  if (!name.toLowerCase().endsWith(".md") || name.length <= ".md".length) {
    return null;
  }

  return name.slice(0, -".md".length);
}
