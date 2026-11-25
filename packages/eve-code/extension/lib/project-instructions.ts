import { createHash } from "node:crypto";
import { defineInstructions, type InstructionsDefinition } from "eve/instructions";

import type { RepositoryInstructionFile } from "../extension.ts";
import type { RecordedRepository, RecordedScope, RepositorySessionState } from "./repo-state.ts";
import { DEFAULT_MAX_TOTAL_BYTES, MAX_OVERFLOW_PATHS } from "./repositories.ts";

export interface ProjectInstructionsFile {
  readonly path: string;
  readonly content: string;
}

export function formatProjectInstructions(file: ProjectInstructionsFile): string {
  return [
    "Project-specific instructions and guidelines:",
    `<project_instructions path="${escapeXmlAttr(file.path)}">\n${neutralizeInstructionContent(file.content)}\n</project_instructions>`,
  ].join("\n\n");
}

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

function formatRepositoryFile(
  repoLabel: string,
  repoRoot: string,
  file: RepositoryInstructionFile,
): string {
  const repoAttr = escapeXmlAttr(repoLabel);
  const pathAttr = escapeXmlAttr(file.path);
  if (file.source === "unavailable") {
    return [
      `<repository_instructions repo="${repoAttr}" path="${pathAttr}" source="unavailable">`,
      `${file.relativePath} exists at HEAD in ${repoLabel} (${repoRoot}) but was excluded by a sparse or partial checkout and could not be fetched automatically. Check out ${file.relativePath} or read it from the remote repository before modifying code in this repository.`,
      `</repository_instructions>`,
    ].join("\n");
  }
  return [
    `<repository_instructions repo="${repoAttr}" path="${pathAttr}" source="${file.source}">`,
    neutralizeInstructionContent(file.content ?? ""),
    `</repository_instructions>`,
  ].join("\n");
}

export function formatRepositoryInstructions(
  repo: Pick<RecordedRepository, "root" | "slug" | "instructions">,
  extraFiles: readonly RepositoryInstructionFile[] = [],
  extraInstructions: readonly string[] = [],
): string | null {
  const repoLabel = repo.slug ?? repo.root;
  const repoAttr = escapeXmlAttr(repoLabel);
  const blocks: string[] = [];

  const authorNotes = extraInstructions
    .map((note) => note.trim())
    .filter((note) => note.length > 0);
  if (authorNotes.length > 0) {
    blocks.push(
      [
        `<repository_rules repo="${repoAttr}">`,
        neutralizeInstructionContent(authorNotes.join("\n\n")),
        `</repository_rules>`,
      ].join("\n"),
    );
  }

  const seenPaths = new Set<string>();
  for (const file of [...repo.instructions, ...extraFiles]) {
    if (seenPaths.has(file.relativePath)) continue;
    seenPaths.add(file.relativePath);
    blocks.push(formatRepositoryFile(repoLabel, repo.root, file));
  }

  if (blocks.length === 0) return null;
  return blocks.join("\n\n");
}

export function formatScopedInstructions(scope: RecordedScope): string | null {
  if (scope.files.length === 0) return null;
  const repoLabel = scope.repoSlug ?? scope.repoRoot;
  const repoAttr = repoLabel === null ? "" : ` repo="${escapeXmlAttr(repoLabel)}"`;
  const blocks: string[] = [];

  for (const file of scope.files) {
    const pathAttr = escapeXmlAttr(file.path);
    if (file.source === "unavailable") {
      const location =
        repoLabel === null ? scope.dir : `${repoLabel} (${scope.repoRoot ?? scope.dir})`;
      blocks.push(
        [
          `<scoped_instructions${repoAttr} path="${pathAttr}" source="unavailable">`,
          `${file.relativePath} exists at HEAD in ${location} but was excluded by a sparse or partial checkout and could not be fetched automatically. Check out ${file.relativePath} or read it from the remote repository before modifying code in ${scope.dir}.`,
          `</scoped_instructions>`,
        ].join("\n"),
      );
    } else {
      blocks.push(
        [
          `<scoped_instructions${repoAttr} path="${pathAttr}">`,
          neutralizeInstructionContent(file.content ?? ""),
          `</scoped_instructions>`,
        ].join("\n"),
      );
    }
  }

  return blocks.join("\n\n");
}

function formatWorkspaceInstructions(files: readonly RepositoryInstructionFile[]): string | null {
  const readable = files.filter(
    (file): file is RepositoryInstructionFile & { readonly content: string } =>
      file.source !== "unavailable" && file.content !== null && file.content.trim().length > 0,
  );
  if (readable.length === 0) return null;
  if (readable.length === 1) {
    const first = readable[0]!;
    return formatProjectInstructions({ path: first.path, content: first.content });
  }
  return [
    "Project-specific instructions and guidelines:",
    ...readable.map(
      (file) =>
        `<project_instructions path="${escapeXmlAttr(file.path)}">\n${neutralizeInstructionContent(file.content)}\n</project_instructions>`,
    ),
  ].join("\n\n");
}

interface CandidateInstructionEntry {
  readonly key: string;
  readonly content: string;
  readonly paths: readonly string[];
}

export function buildKeyedInstructions(
  state: Pick<RepositorySessionState, "workspaceInstruction" | "byRoot" | "scopes"> & {
    readonly overflowPaths?: readonly string[];
  },
  maxTotalBytes: number = DEFAULT_MAX_TOTAL_BYTES,
): Readonly<Record<string, InstructionsDefinition>> | null {
  const candidates: CandidateInstructionEntry[] = [];

  const workspaceContent = formatWorkspaceInstructions(state.workspaceInstruction);
  if (workspaceContent !== null) {
    candidates.push({
      key: "workspace",
      content: workspaceContent,
      paths: state.workspaceInstruction.map((file) => file.path),
    });
  }

  for (const repo of Object.values(state.byRoot)) {
    const content = formatRepositoryInstructions(repo, repo.ruleFiles, repo.ruleInstructions);
    if (content !== null) {
      const paths = [
        ...new Set([
          ...repo.instructions.map((file) => file.path),
          ...repo.ruleFiles.map((file) => file.path),
        ]),
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
        paths: scope.files.map((file) => file.path),
      });
    }
  }

  const preOverflow = state.overflowPaths ?? [];
  if (candidates.length === 0 && preOverflow.length === 0) return null;

  const result: Record<string, InstructionsDefinition> = {};
  const overflowPaths: string[] = [];
  const pushOverflow = (p: string) => {
    if (p.length === 0 || overflowPaths.includes(p)) return;
    if (overflowPaths.length >= MAX_OVERFLOW_PATHS) return;
    overflowPaths.push(p);
  };
  let usedBytes = 0;

  for (const candidate of candidates) {
    const entryBytes = Buffer.byteLength(candidate.content, "utf8");
    if (usedBytes + entryBytes <= maxTotalBytes) {
      result[candidate.key] = defineInstructions({ content: candidate.content, role: "user" });
      usedBytes += entryBytes;
    } else {
      for (const p of candidate.paths) {
        pushOverflow(p);
      }
    }
  }

  for (const p of preOverflow) {
    pushOverflow(p);
  }

  if (overflowPaths.length > 0) {
    const lines = overflowPaths.map((p) => `- ${p}`).join("\n");
    result.overflow = defineInstructions({
      content: `Additional repository or scoped instruction files exceeded the automatic instruction byte budget (${maxTotalBytes} bytes). Use \`read_file\` to read them when working in those areas:\n${lines}`,
      role: "user",
    });
  }

  return Object.keys(result).length === 0 ? null : result;
}
