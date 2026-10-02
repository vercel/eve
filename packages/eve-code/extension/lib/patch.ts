import { posix } from "node:path";

import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "./shell.ts";

type PatchHunk =
  | { readonly type: "add"; readonly path: string; readonly contents: string }
  | { readonly type: "delete"; readonly path: string }
  | {
      readonly type: "update";
      readonly path: string;
      readonly movePath?: string;
      readonly chunks: readonly UpdateChunk[];
    };

interface UpdateChunk {
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly changeContext?: string;
  readonly endOfFile?: boolean;
}

export interface AppliedPatchFile {
  readonly operation: "add" | "delete" | "move" | "update";
  readonly path: string;
  readonly previousPath?: string;
}

interface PlannedChange extends AppliedPatchFile {
  readonly absolutePath: string;
  readonly previousAbsolutePath?: string;
  readonly oldContent: string | null;
  readonly oldMode?: string;
  readonly newContent: string | null;
}

const MAX_PATCH_FILES = 100;
const MISMATCH_EXCERPT_RADIUS = 4;
const MISMATCH_EXCERPT_MAX_LINES = 16;
const MISMATCH_EXPECTED_MAX_LINES = 20;
const patchLocks = new Map<string, Promise<void>>();

export async function applyPatchToSandbox(input: {
  readonly beforeCommit?: (files: readonly AppliedPatchFile[]) => Promise<void>;
  readonly patchText: string;
  readonly repoRoot: string;
  readonly sandbox: SandboxSession;
  /** Serializes patches per eve session; every `ctx.getSandbox()` call returns a new handle. */
  readonly sessionId: string;
}): Promise<AppliedPatchFile[]> {
  return withPatchLock(`${input.sessionId}:${input.repoRoot}`, () => applyPatchUnlocked(input));
}

async function applyPatchUnlocked(input: {
  readonly beforeCommit?: (files: readonly AppliedPatchFile[]) => Promise<void>;
  readonly patchText: string;
  readonly repoRoot: string;
  readonly sandbox: SandboxSession;
}): Promise<AppliedPatchFile[]> {
  const hunks = parsePatch(input.patchText);
  if (hunks.length === 0) throw new Error("patch rejected: empty patch");
  if (hunks.length > MAX_PATCH_FILES) {
    throw new Error(`patch rejected: at most ${MAX_PATCH_FILES} file operations are allowed`);
  }

  const changes = await planChanges(input.sandbox, input.repoRoot, hunks);
  await input.beforeCommit?.(
    changes.map(({ operation, path, previousPath }) => {
      const file: { -readonly [Key in keyof AppliedPatchFile]: AppliedPatchFile[Key] } = {
        operation,
        path,
      };
      if (previousPath !== undefined) file.previousPath = previousPath;
      return file;
    }),
  );
  const committed: PlannedChange[] = [];
  try {
    for (const change of changes) {
      await revalidateChange(input.sandbox, input.repoRoot, change);
      committed.push(change);
      await commitChange(input.sandbox, change);
    }
  } catch (error) {
    const rollbackErrors = await rollbackChanges(input.sandbox, committed);
    const detail = error instanceof Error ? error.message : String(error);
    const rollback =
      rollbackErrors.length === 0 ? "" : ` Rollback also failed: ${rollbackErrors.join("; ")}`;
    throw new Error(`apply_patch failed after validation: ${detail}.${rollback}`, { cause: error });
  }

  return changes.map(({ operation, path, previousPath }) => {
    const file: { -readonly [Key in keyof AppliedPatchFile]: AppliedPatchFile[Key] } = {
      operation,
      path,
    };
    if (previousPath !== undefined) file.previousPath = previousPath;
    return file;
  });
}

async function withPatchLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = patchLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  patchLocks.set(key, queued);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (patchLocks.get(key) === queued) patchLocks.delete(key);
  }
}

export function parsePatch(patchText: string): readonly PatchHunk[] {
  const lines = stripHeredoc(normalizeLineEndings(patchText).trim()).split("\n");
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const end = lines.findIndex((line, index) => index > begin && line.trim() === "*** End Patch");
  if (begin === -1 || end === -1 || begin >= end) {
    throw new Error("invalid patch format: missing Begin/End markers");
  }
  if (
    lines
      .slice(0, begin)
      .some((line) => line.trim().length > 0 && !line.trimStart().startsWith("*** Environment ID:"))
  ) {
    throw new Error("invalid patch format: unexpected content before Begin Patch");
  }
  if (lines.slice(end + 1).some((line) => line.trim().length > 0)) {
    throw new Error("invalid patch format: unexpected content after End Patch");
  }

  const hunks: PatchHunk[] = [];
  let index = begin + 1;
  while (index < end) {
    const line = lines[index] ?? "";
    if (line.startsWith("*** Environment ID:")) {
      index += 1;
      continue;
    }
    if (line.startsWith("*** Add File:")) {
      const path = requirePath(line.slice("*** Add File:".length), "add");
      const parsed = parseAdd(lines, index + 1, end);
      hunks.push({ type: "add", path, contents: parsed.content });
      index = parsed.next;
      continue;
    }
    if (line.startsWith("*** Delete File:")) {
      hunks.push({
        type: "delete",
        path: requirePath(line.slice("*** Delete File:".length), "delete"),
      });
      index += 1;
      continue;
    }
    if (line.startsWith("*** Update File:")) {
      const path = requirePath(line.slice("*** Update File:".length), "update");
      let next = index + 1;
      let movePath: string | undefined;
      if (lines[next]?.startsWith("*** Move to:")) {
        movePath = requirePath(lines[next]!.slice("*** Move to:".length), "move");
        next += 1;
      }
      const parsed = parseUpdate(lines, next, end);
      if (parsed.chunks.length === 0 && movePath === undefined) {
        throw new Error(`invalid update hunk for ${path}: expected at least one @@ chunk`);
      }
      hunks.push({ type: "update", path, movePath, chunks: parsed.chunks });
      index = parsed.next;
      continue;
    }
    throw new Error(`invalid patch line: ${line}`);
  }
  return hunks;
}

export function deriveUpdatedContent(
  path: string,
  chunks: readonly UpdateChunk[],
  original: string,
): string {
  const lineEnding = original.includes("\r\n") ? "\r\n" : "\n";
  const source = splitBom(normalizeLineEndings(original));
  const lines = source.text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const replacements = computeReplacements(lines, path, chunks);
  const updated = [...lines];
  for (const [start, remove, insert] of replacements.toReversed()) {
    updated.splice(start, remove, ...insert);
  }
  if (updated.at(-1) !== "") updated.push("");
  const content = updated.join("\n").replaceAll("\n", lineEnding);
  return source.bom ? `\uFEFF${content}` : content;
}

function parseAdd(lines: readonly string[], start: number, end: number) {
  const content: string[] = [];
  let index = start;
  while (index < end && !lines[index]!.startsWith("***")) {
    const line = lines[index]!;
    if (!line.startsWith("+")) throw new Error(`invalid add file line: ${line}`);
    content.push(line.slice(1));
    index += 1;
  }
  return { content: content.join("\n"), next: index };
}

function parseUpdate(lines: readonly string[], start: number, end: number) {
  const chunks: UpdateChunk[] = [];
  let index = start;
  while (index < end && !lines[index]!.startsWith("***")) {
    const headerLine = lines[index]!;
    const hasHeader = headerLine.startsWith("@@");
    if (!hasHeader && chunks.length > 0) {
      throw new Error(`invalid update file line: ${lines[index]}`);
    }
    const changeContext = hasHeader ? headerLine.slice(2).trim() || undefined : undefined;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let endOfFile = false;
    if (hasHeader) index += 1;
    while (index < end && !lines[index]!.startsWith("@@")) {
      const line = lines[index]!;
      if (line === "*** End of File") {
        endOfFile = true;
        index += 1;
        while (index < end && lines[index] === "") index += 1;
        break;
      }
      if (line.startsWith("***")) break;
      if (line === "") {
        oldLines.push("");
        newLines.push("");
      } else if (line.startsWith(" ")) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      } else {
        throw new Error(`invalid update chunk line: ${line}`);
      }
      index += 1;
    }
    chunks.push({ oldLines, newLines, changeContext, endOfFile: endOfFile || undefined });
  }
  return { chunks, next: index };
}

async function planChanges(
  sandbox: SandboxSession,
  repoRoot: string,
  hunks: readonly PatchHunk[],
): Promise<PlannedChange[]> {
  const resolvedRoot = await realPath(sandbox, repoRoot);
  if (resolvedRoot !== repoRoot) {
    throw new Error(
      `apply_patch verification failed: repository root resolves outside itself: ${repoRoot}`,
    );
  }
  const claimed = new Set<string>();
  const changes: PlannedChange[] = [];
  const errors: string[] = [];
  for (const hunk of hunks) {
    try {
      changes.push(await planHunk(sandbox, repoRoot, claimed, hunk));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n\n"));
  }
  return changes;
}

async function planHunk(
  sandbox: SandboxSession,
  repoRoot: string,
  claimed: Set<string>,
  hunk: PatchHunk,
): Promise<PlannedChange> {
  const source = resolvePatchPath(repoRoot, hunk.path);
  await assertRealPath(sandbox, repoRoot, source.absolutePath);
  claimPath(claimed, source.absolutePath);

  if (hunk.type === "add") {
    if ((await sandbox.readTextFile({ path: source.absolutePath })) !== null) {
      throw new Error(`apply_patch verification failed: file already exists: ${source.path}`);
    }
    return {
      absolutePath: source.absolutePath,
      newContent:
        hunk.contents.length === 0 || hunk.contents.endsWith("\n")
          ? hunk.contents
          : `${hunk.contents}\n`,
      oldContent: null,
      operation: "add",
      path: source.path,
    };
  }

  const oldContent = await sandbox.readTextFile({ path: source.absolutePath });
  if (oldContent === null) {
    throw new Error(`apply_patch verification failed: file not found: ${source.path}`);
  }
  const oldMode = await fileMode(sandbox, source.absolutePath);
  if (hunk.type === "delete") {
    return {
      absolutePath: source.absolutePath,
      newContent: null,
      oldContent,
      oldMode,
      operation: "delete",
      path: source.path,
    };
  }

  const target = hunk.movePath === undefined ? source : resolvePatchPath(repoRoot, hunk.movePath);
  if (target.absolutePath !== source.absolutePath) {
    await assertRealPath(sandbox, repoRoot, target.absolutePath);
    claimPath(claimed, target.absolutePath);
    if ((await sandbox.readTextFile({ path: target.absolutePath })) !== null) {
      throw new Error(
        `apply_patch verification failed: move target already exists: ${target.path}`,
      );
    }
  }
  const newContent =
    hunk.chunks.length === 0
      ? oldContent
      : deriveUpdatedContent(source.path, hunk.chunks, oldContent);
  if (newContent === oldContent && target.absolutePath === source.absolutePath) {
    throw new Error(`apply_patch verification failed: update makes no changes: ${source.path}`);
  }
  const change: { -readonly [Key in keyof PlannedChange]: PlannedChange[Key] } = {
    absolutePath: target.absolutePath,
    newContent,
    oldContent,
    oldMode,
    operation: target.absolutePath === source.absolutePath ? "update" : "move",
    path: target.path,
  };
  if (target.absolutePath !== source.absolutePath) {
    change.previousAbsolutePath = source.absolutePath;
    change.previousPath = source.path;
  }
  return change;
}

async function commitChange(sandbox: SandboxSession, change: PlannedChange): Promise<void> {
  if (change.operation === "delete") {
    await sandbox.removePath({ path: change.absolutePath });
    return;
  }
  if (change.operation === "move" && change.previousAbsolutePath !== undefined) {
    await atomicWrite(sandbox, {
      content: change.newContent ?? "",
      mode: change.oldMode,
      overwrite: false,
      path: change.absolutePath,
    });
    await sandbox.removePath({ path: change.previousAbsolutePath });
    return;
  }
  await atomicWrite(sandbox, {
    content: change.newContent ?? "",
    mode: change.oldMode,
    overwrite: change.operation !== "add",
    path: change.absolutePath,
  });
}

async function revalidateChange(
  sandbox: SandboxSession,
  repoRoot: string,
  change: PlannedChange,
): Promise<void> {
  await assertRealPath(sandbox, repoRoot, change.absolutePath);
  if (change.operation === "add") {
    if ((await sandbox.readTextFile({ path: change.absolutePath })) !== null) {
      throw new Error(`apply_patch stale write: add target now exists: ${change.path}`);
    }
    return;
  }
  if (change.operation === "move" && change.previousAbsolutePath !== undefined) {
    await assertRealPath(sandbox, repoRoot, change.previousAbsolutePath);
    const [source, target] = await Promise.all([
      sandbox.readTextFile({ path: change.previousAbsolutePath }),
      sandbox.readTextFile({ path: change.absolutePath }),
    ]);
    if (source !== change.oldContent || target !== null) {
      throw new Error(`apply_patch stale write: move inputs changed: ${change.previousPath}`);
    }
    return;
  }
  const current = await sandbox.readTextFile({ path: change.absolutePath });
  if (current !== change.oldContent) {
    throw new Error(`apply_patch stale write: file changed after validation: ${change.path}`);
  }
}

async function rollbackChanges(
  sandbox: SandboxSession,
  committed: readonly PlannedChange[],
): Promise<string[]> {
  const errors: string[] = [];
  for (const change of committed.toReversed()) {
    try {
      const current = await sandbox.readTextFile({ path: change.absolutePath });
      if (change.operation === "add") {
        if (current === null) continue;
        if (current !== change.newContent) {
          throw new Error(`refusing to remove concurrently changed file ${change.path}`);
        }
        await sandbox.removePath({ path: change.absolutePath });
      } else if (change.operation === "move" && change.previousAbsolutePath !== undefined) {
        const source = await sandbox.readTextFile({ path: change.previousAbsolutePath });
        if (current === change.newContent && source === null) {
          await atomicWrite(sandbox, {
            content: change.oldContent ?? "",
            mode: change.oldMode,
            overwrite: false,
            path: change.previousAbsolutePath,
          });
          await sandbox.removePath({ path: change.absolutePath });
        } else if (current === change.newContent && source === change.oldContent) {
          await sandbox.removePath({ path: change.absolutePath });
        } else if (current === null && source === change.newContent) {
          await atomicWrite(sandbox, {
            content: change.oldContent ?? "",
            mode: change.oldMode,
            overwrite: true,
            path: change.previousAbsolutePath,
          });
        } else if (!(current === null && source === change.oldContent)) {
          throw new Error(`refusing to roll back concurrently changed move ${change.path}`);
        }
      } else if (change.operation === "delete") {
        if (current === null) {
          await atomicWrite(sandbox, {
            content: change.oldContent ?? "",
            mode: change.oldMode,
            overwrite: false,
            path: change.absolutePath,
          });
        } else if (current !== change.oldContent) {
          throw new Error(`refusing to overwrite concurrently recreated file ${change.path}`);
        }
      } else {
        if (current === change.oldContent) continue;
        if (current !== change.newContent) {
          throw new Error(`refusing to overwrite concurrently changed file ${change.path}`);
        }
        await atomicWrite(sandbox, {
          content: change.oldContent ?? "",
          mode: change.oldMode,
          overwrite: true,
          path: change.absolutePath,
        });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

async function assertRealPath(
  sandbox: SandboxSession,
  repoRoot: string,
  absolutePath: string,
): Promise<void> {
  const resolved = await realPath(sandbox, absolutePath);
  if (resolved !== absolutePath || !resolved.startsWith(`${repoRoot}/`)) {
    throw new Error(
      `apply_patch verification failed: path crosses a symlink or repository boundary: ${absolutePath}`,
    );
  }
}

async function realPath(sandbox: SandboxSession, path: string): Promise<string> {
  const result = await sandbox.run({ command: `realpath -m -- ${shellQuote(path)}` });
  if (result.exitCode !== 0) {
    throw new Error(`apply_patch verification failed: could not resolve ${path}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function ensureParentDirectory(sandbox: SandboxSession, path: string): Promise<void> {
  const result = await sandbox.run({ command: `mkdir -p -- ${shellQuote(posix.dirname(path))}` });
  if (result.exitCode !== 0) {
    throw new Error(`failed to create parent directory for ${path}: ${result.stderr}`);
  }
}

async function atomicWrite(
  sandbox: SandboxSession,
  input: {
    readonly content: string;
    readonly mode?: string;
    readonly overwrite: boolean;
    readonly path: string;
  },
): Promise<void> {
  await ensureParentDirectory(sandbox, input.path);
  const temporaryPath = posix.join(
    posix.dirname(input.path),
    `.${posix.basename(input.path)}.eve-code-${crypto.randomUUID()}.tmp`,
  );
  let moved = false;
  try {
    await sandbox.writeTextFile({ path: temporaryPath, content: input.content });
    await restoreMode(sandbox, temporaryPath, input.mode);
    const result = await sandbox.run({
      command: `mv ${input.overwrite ? "" : "-n "}-- ${shellQuote(temporaryPath)} ${shellQuote(input.path)}`,
    });
    if (result.exitCode !== 0) {
      throw new Error(`failed to install ${input.path}: ${result.stderr || result.stdout}`);
    }
    if (!input.overwrite && (await sandbox.readTextFile({ path: temporaryPath })) !== null) {
      throw new Error(`apply_patch stale write: target now exists: ${input.path}`);
    }
    moved = true;
  } finally {
    if (!moved) await sandbox.removePath({ path: temporaryPath, force: true }).catch(() => {});
  }
}

async function fileMode(sandbox: SandboxSession, path: string): Promise<string> {
  const result = await sandbox.run({ command: `stat -c %a -- ${shellQuote(path)}` });
  const mode = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[0-7]{3,4}$/u.test(mode)) {
    throw new Error(`apply_patch verification failed: could not read file mode for ${path}`);
  }
  return mode;
}

async function restoreMode(
  sandbox: SandboxSession,
  path: string,
  mode: string | undefined,
): Promise<void> {
  if (mode === undefined) return;
  const result = await sandbox.run({ command: `chmod ${mode} -- ${shellQuote(path)}` });
  if (result.exitCode !== 0) throw new Error(`failed to restore file mode for ${path}`);
}

function resolvePatchPath(repoRoot: string, candidate: string) {
  const normalized = candidate.replaceAll("\\", "/").trim();
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    posix.isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`invalid patch path: ${candidate}`);
  }
  return { absolutePath: posix.join(repoRoot, normalized), path: normalized };
}

function claimPath(claimed: Set<string>, path: string): void {
  if (claimed.has(path)) throw new Error(`patch contains overlapping file operations: ${path}`);
  claimed.add(path);
}

function requirePath(value: string, operation: string): string {
  const path = value.trim();
  if (path.length === 0) throw new Error(`invalid ${operation} file path`);
  return path;
}

function computeReplacements(
  lines: readonly string[],
  path: string,
  chunks: readonly UpdateChunk[],
) {
  const replacements: Array<readonly [start: number, remove: number, insert: readonly string[]]> =
    [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const context = seek(lines, [chunk.changeContext], lineIndex);
      if (context === -1) {
        throw new Error(formatMissingContextError(path, chunk.changeContext, lines, lineIndex));
      }
      lineIndex = context + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, chunk.newLines]);
      continue;
    }
    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seek(lines, oldLines, lineIndex, chunk.endOfFile);
    if (found === -1 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = seek(lines, oldLines, lineIndex, chunk.endOfFile);
    }
    if (found === -1) {
      throw new Error(formatMissingLinesError(path, chunk.oldLines, lines, lineIndex));
    }
    replacements.push([found, oldLines.length, newLines]);
    lineIndex = found + oldLines.length;
  }
  return replacements.toSorted((left, right) => left[0] - right[0]);
}

function formatMissingLinesError(
  path: string,
  expected: readonly string[],
  lines: readonly string[],
  startIndex: number,
): string {
  return [
    `failed to find expected lines in ${path}.`,
    "",
    "Expected:",
    boundLines(expected, MISMATCH_EXPECTED_MAX_LINES),
    "",
    currentExcerpt(lines, expected, startIndex),
    "",
    `Re-read ${path} and rewrite this hunk against the current contents.`,
  ].join("\n");
}

function formatMissingContextError(
  path: string,
  context: string,
  lines: readonly string[],
  startIndex: number,
): string {
  return [
    `failed to find context '${context}' in ${path}.`,
    "",
    currentExcerpt(lines, [context], startIndex),
    "",
    `Re-read ${path} and rewrite this hunk against the current contents.`,
  ].join("\n");
}

function currentExcerpt(
  lines: readonly string[],
  pattern: readonly string[],
  startIndex: number,
): string {
  if (lines.length === 0) return "Current file is empty.";
  const found = closestMatchIndex(lines, pattern, startIndex);
  const center = found === -1 ? Math.min(startIndex, Math.max(0, lines.length - 1)) : found;
  const start = Math.max(0, center - MISMATCH_EXCERPT_RADIUS);
  const end = Math.min(lines.length, start + MISMATCH_EXCERPT_MAX_LINES);
  const heading =
    found === -1 ? `Current contents from line ${start + 1}:` : "Closest current content:";
  return `${heading}\n${numberedLines(lines, start, end)}`;
}

function closestMatchIndex(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
): number {
  const needles = pattern
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted((left, right) => right.length - left.length)
    .slice(0, 3);
  for (const needle of needles) {
    const fromStart = seek(lines, [needle], start);
    if (fromStart !== -1) return fromStart;
    const fromTop = seek(lines, [needle], 0);
    if (fromTop !== -1) return fromTop;
  }
  return closestScoredLine(lines, pattern);
}

function closestScoredLine(lines: readonly string[], pattern: readonly string[]): number {
  const tokens = new Set(
    pattern
      .join(" ")
      .toLowerCase()
      .split(/\W+/u)
      .filter((token) => token.length > 2),
  );
  if (tokens.size === 0) return -1;
  let best = -1;
  let bestScore = 0;
  for (let index = 0; index < lines.length; index += 1) {
    let score = 0;
    for (const token of lines[index]!.toLowerCase().split(/\W+/u)) {
      if (tokens.has(token)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return bestScore >= 2 ? best : -1;
}

function boundLines(lines: readonly string[], max: number): string {
  if (lines.length <= max) return lines.join("\n");
  return `${lines.slice(0, max).join("\n")}\n[${lines.length - max} more expected lines omitted]`;
}

function numberedLines(lines: readonly string[], start: number, end: number): string {
  const width = String(end).length;
  return lines
    .slice(start, end)
    .map((line, index) => `${String(start + index + 1).padStart(width, " ")} | ${line}`)
    .join("\n");
}

function seek(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile = false,
): number {
  if (pattern.length === 0) return -1;
  for (const compare of [exact, trimEnd, trim, normalized]) {
    if (endOfFile) {
      const offset = lines.length - pattern.length;
      if (offset >= start && matches(lines, pattern, offset, compare)) return offset;
    }
    for (let offset = start; offset <= lines.length - pattern.length; offset += 1) {
      if (matches(lines, pattern, offset, compare)) return offset;
    }
  }
  return -1;
}

function matches(
  lines: readonly string[],
  pattern: readonly string[],
  offset: number,
  compare: (left: string, right: string) => boolean,
): boolean {
  return pattern.every((line, index) => compare(lines[offset + index]!, line));
}

const exact = (left: string, right: string) => left === right;
const trimEnd = (left: string, right: string) => left.trimEnd() === right.trimEnd();
const trim = (left: string, right: string) => left.trim() === right.trim();
const normalized = (left: string, right: string) =>
  normalizeTypography(left.trim()) === normalizeTypography(right.trim());

function normalizeTypography(value: string): string {
  return value
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"')
    .replace(/[‐‑‒–—―]/gu, "-")
    .replace(/…/gu, "...")
    .replace(/ /gu, " ");
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function splitBom(value: string) {
  return value.startsWith("\uFEFF")
    ? { bom: true, text: value.slice(1) }
    : { bom: false, text: value };
}

function stripHeredoc(input: string): string {
  return input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/u)?.[2] ?? input;
}
