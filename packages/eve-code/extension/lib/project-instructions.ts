import { createHash } from "node:crypto";
import { defineInstructions, type InstructionsDefinition } from "eve/instructions";

import type { RepositoryInstructionFile } from "../extension.ts";
import type { RecordedRepository, RecordedScope, RepositorySessionState } from "./repo-state.ts";
import {
  appendOverflowPaths,
  DEFAULT_MAX_TOTAL_BYTES,
  MAX_OVERFLOW_PATHS,
} from "./repositories.ts";

export function escapeXmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function neutralizeInstructionContent(content: string): string {
  return content.replace(
    /<\/((?:repository|scoped|project)_instructions|repository_rules)\b/giu,
    "&lt;/$1",
  );
}

function hashInstructionKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function repositoryInstructionKey(root: string): string {
  return `repo:${hashInstructionKey(root)}`;
}

export function scopedInstructionKey(dir: string): string {
  return `scope:${hashInstructionKey(dir)}`;
}

function unavailableGuidance(relativePath: string, location: string, targetArea: string): string {
  return neutralizeInstructionContent(
    `${relativePath} exists at HEAD in ${location} but was excluded by a sparse or partial checkout and could not be fetched automatically. Check out ${relativePath} or read it from the remote repository before modifying code in ${targetArea}.`,
  );
}

export function formatRepositoryInstructions(
  repo: Pick<RecordedRepository, "root" | "slug" | "instructions">,
  extraFiles: readonly RepositoryInstructionFile[] = [],
  extraInstructions: readonly string[] = [],
): string | null {
  const repoLabel = repo.slug ?? repo.root;
  const repoAttr = escapeXmlAttr(repoLabel);
  const blocks: string[] = [];

  const authorNotes = extraInstructions.map((n) => n.trim()).filter(Boolean);
  if (authorNotes.length > 0) {
    blocks.push(
      `<repository_rules repo="${repoAttr}">\n${neutralizeInstructionContent(authorNotes.join("\n\n"))}\n</repository_rules>`,
    );
  }

  const seenPaths = new Set<string>();
  for (const file of [...repo.instructions, ...extraFiles]) {
    if (seenPaths.has(file.relativePath)) continue;
    seenPaths.add(file.relativePath);
    const body =
      file.source === "unavailable"
        ? unavailableGuidance(file.relativePath, `${repoLabel} (${repo.root})`, "this repository")
        : neutralizeInstructionContent(file.content ?? "");
    blocks.push(
      `<repository_instructions repo="${repoAttr}" path="${escapeXmlAttr(file.path)}" source="${file.source}">\n${body}\n</repository_instructions>`,
    );
  }

  return blocks.length === 0 ? null : blocks.join("\n\n");
}

export function formatScopedInstructions(scope: RecordedScope): string | null {
  if (scope.files.length === 0) return null;
  const repoLabel = scope.repoSlug ?? scope.repoRoot;
  const repoAttr = repoLabel === null ? "" : ` repo="${escapeXmlAttr(repoLabel)}"`;
  const location = repoLabel === null ? scope.dir : `${repoLabel} (${scope.repoRoot ?? scope.dir})`;
  return scope.files
    .map((file) => {
      const pathAttr = escapeXmlAttr(file.path);
      if (file.source === "unavailable") {
        return `<scoped_instructions${repoAttr} path="${pathAttr}" source="unavailable">\n${unavailableGuidance(file.relativePath, location, scope.dir)}\n</scoped_instructions>`;
      }
      return `<scoped_instructions${repoAttr} path="${pathAttr}">\n${neutralizeInstructionContent(file.content ?? "")}\n</scoped_instructions>`;
    })
    .join("\n\n");
}

function formatWorkspaceInstructions(files: readonly RepositoryInstructionFile[]): string | null {
  const readable = files.filter(
    (file): file is RepositoryInstructionFile & { readonly content: string } =>
      file.source !== "unavailable" && file.content !== null && file.content.trim().length > 0,
  );
  if (readable.length === 0) return null;
  return [
    "Project-specific instructions and guidelines:",
    ...readable.map(
      (file) =>
        `<project_instructions path="${escapeXmlAttr(file.path)}">\n${neutralizeInstructionContent(file.content)}\n</project_instructions>`,
    ),
  ].join("\n\n");
}

export function buildKeyedInstructions(
  state: Pick<RepositorySessionState, "workspaceInstruction" | "byRoot" | "scopes"> & {
    readonly overflowPaths?: readonly string[];
  },
  maxTotalBytes: number = DEFAULT_MAX_TOTAL_BYTES,
): Readonly<Record<string, InstructionsDefinition>> | null {
  const candidates: {
    readonly key: string;
    readonly content: string;
    readonly paths: readonly string[];
  }[] = [];

  const workspaceContent = formatWorkspaceInstructions(state.workspaceInstruction);
  if (workspaceContent !== null) {
    candidates.push({
      key: "workspace",
      content: workspaceContent,
      paths: state.workspaceInstruction.map((f) => f.path),
    });
  }

  for (const repo of Object.values(state.byRoot)) {
    const content = formatRepositoryInstructions(repo, repo.ruleFiles, repo.ruleInstructions);
    if (content !== null) {
      const paths = [
        ...new Set([...repo.instructions.map((f) => f.path), ...repo.ruleFiles.map((f) => f.path)]),
      ];
      candidates.push({
        key: repositoryInstructionKey(repo.root),
        content,
        paths: paths.length > 0 ? paths : [repo.root],
      });
    }
  }

  for (const scope of Object.values(state.scopes)) {
    const content = formatScopedInstructions(scope);
    if (content !== null) {
      candidates.push({
        key: scopedInstructionKey(scope.dir),
        content,
        paths: scope.files.map((f) => f.path),
      });
    }
  }

  const preOverflow = state.overflowPaths ?? [];
  if (candidates.length === 0 && preOverflow.length === 0) return null;

  const result: Record<string, InstructionsDefinition> = {};
  const skippedPaths: string[] = [];
  let usedBytes = 0;

  for (const candidate of candidates) {
    const entryBytes = Buffer.byteLength(candidate.content, "utf8");
    if (usedBytes + entryBytes <= maxTotalBytes) {
      result[candidate.key] = defineInstructions({ content: candidate.content, role: "user" });
      usedBytes += entryBytes;
    } else {
      skippedPaths.push(...candidate.paths);
    }
  }

  const overflowPaths = appendOverflowPaths(
    [],
    [...skippedPaths, ...preOverflow],
    MAX_OVERFLOW_PATHS,
  );

  if (overflowPaths.length > 0) {
    result.overflow = defineInstructions({
      content: `Additional repository or scoped instruction files exceeded the automatic instruction byte budget (${maxTotalBytes} bytes). Use \`read_file\` to read them when working in those areas:\n${overflowPaths.map((p) => `- ${p}`).join("\n")}`,
      role: "user",
    });
  }

  return Object.keys(result).length === 0 ? null : result;
}
