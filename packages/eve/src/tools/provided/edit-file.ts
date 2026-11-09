import type { SandboxSession } from "#public/sandbox/index.js";
import { defineTool, toolOutput, type ToolDefinition } from "#public/tools/index.js";
import { defineJsonSchema, prepareJsonSchema } from "#tools/schema.js";

import { frameworkTool } from "./framework-tool.js";
import { refreshReadFileStamp } from "./write-file.js";

// Ported from pi's `edit` tool (packages/coding-agent/src/core/tools/edit.ts and
// edit-diff.ts in badlogic/pi-mono v1.5.0): the same input, matching, errors,
// and model text, running against the agent's sandbox.

export interface EditFileToolEdit {
  newText: string;
  oldText: string;
}

export interface EditFileToolInput {
  edits: EditFileToolEdit[];
  path: string;
}

export interface EditFileToolOutput {
  /** The path as the model gave it. */
  path: string;
  replacements: number;
}

const GUIDELINES = [
  "Use edit_file for targeted changes. Batch changes to one file in a single call.",
  "Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
];

// Before validation, repairs the shapes models send instead: `edits` as a JSON
// string or a single object, and a top-level `oldText`/`newText` pair.
const EDIT_FILE_INPUT_SCHEMA = prepareJsonSchema<EditFileToolInput>(
  {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: {
              type: "string",
              description:
                "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
            },
            newText: { type: "string", description: "Replacement text for this targeted edit." },
          },
          required: ["oldText", "newText"],
        },
        description:
          "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
      },
    },
    required: ["path", "edits"],
  },
  prepareEditArguments,
);

const EDIT_FILE_OUTPUT_SCHEMA = defineJsonSchema<EditFileToolOutput>({
  type: "object",
  properties: {
    path: { type: "string" },
    replacements: { type: "integer" },
  },
  required: ["path", "replacements"],
  additionalProperties: false,
});

/**
 * Framework-owned executor that edits files in the default sandbox.
 */
export const editFile: ToolDefinition<EditFileToolInput, EditFileToolOutput> = frameworkTool(
  defineTool({
    label: {
      start: (input: EditFileToolInput) =>
        typeof input.path === "string" ? `Edit ${input.path}` : "Edit",
    },
    description: [
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
      "",
      "Guidelines:",
      ...GUIDELINES.map((guideline) => `- ${guideline}`),
    ].join("\n"),
    inputSchema: EDIT_FILE_INPUT_SCHEMA,
    outputSchema: EDIT_FILE_OUTPUT_SCHEMA,
    async execute(input, ctx): Promise<EditFileToolOutput> {
      const { path, edits } = input;
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
      }
      const sandbox = await ctx.getSandbox();
      const absolutePath = await resolveEditPath(sandbox, path);
      const throwIfAborted = (): void => {
        if (ctx.abortSignal.aborted) throw new Error("Operation aborted");
      };

      return await withFileMutationQueue(`${ctx.session.id}\0${absolutePath}`, async () => {
        throwIfAborted();
        const [buffer, mode] = await Promise.all([
          sandbox.readBinaryFile({ path: absolutePath }),
          readFileMode(sandbox, absolutePath),
        ]);
        throwIfAborted();
        if (buffer === null) {
          throw new Error(`Could not edit file: ${path}. Error code: ENOENT.`);
        }

        // The model will not include an invisible BOM in oldText.
        const { bom, text: content } = splitBom(decodeUtf8(buffer, path));
        const originalEnding = detectLineEnding(content);
        const newContent = applyEditsToNormalizedContent(normalizeToLF(content), edits, path);
        throwIfAborted();

        const written = restoreLineEndings(newContent, originalEnding);
        await sandbox.writeTextFile({ path: absolutePath, content: bom + written });
        if (mode !== undefined && mode !== DEFAULT_FILE_MODE) {
          await restoreFileMode(sandbox, absolutePath, mode);
        }
        // readTextFile drops the BOM, so write_file compares against the text without it.
        refreshReadFileStamp(absolutePath, content, written);
        return { path, replacements: edits.length };
      });
    },
    toModelOutput: (output: EditFileToolOutput) =>
      toolOutput.text(`Successfully replaced ${output.replacements} block(s) in ${output.path}.`),
  }),
);

export default editFile;

// Some sandboxes, such as Vercel's, give every written file this mode, so an
// edit restores any other mode the file had, like an executable bit.
const DEFAULT_FILE_MODE = "644";

async function readFileMode(sandbox: SandboxSession, path: string): Promise<string | undefined> {
  try {
    // -L reads the target's mode: chmod follows a symlink, so a link's own 777 must not reach it.
    const result = await sandbox.run({ command: `stat -L -c %a -- ${quoteShell(path)}` });
    const mode = result.stdout.trim();
    return result.exitCode === 0 && /^[0-7]{3,4}$/u.test(mode) ? mode : undefined;
  } catch {
    return undefined;
  }
}

// Best effort: the edit already landed, so a failed chmod must not report it as failed.
async function restoreFileMode(sandbox: SandboxSession, path: string, mode: string): Promise<void> {
  try {
    await sandbox.run({ command: `chmod ${mode} -- ${quoteShell(path)}` });
  } catch {
    // The file keeps the sandbox's default mode.
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Keeps a leading BOM as U+FEFF so it can be split off and written back.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Rejects non-UTF-8 files, which decoding and writing back would corrupt. */
function decodeUtf8(buffer: Uint8Array, path: string): string {
  try {
    return UTF8.decode(buffer);
  } catch {
    throw new Error(`Could not edit file: ${path}. It is not valid UTF-8 text.`);
  }
}

function prepareEditArguments(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const args: Record<string, unknown> = { ...input };

  // Some models send edits as a JSON string instead of an array, others a
  // single edit object instead of a one-element array.
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (isSingleEdit(parsed)) args.edits = [parsed];
    } catch {}
  } else if (isSingleEdit(args.edits)) {
    args.edits = [args.edits];
  }

  if (typeof args.oldText !== "string" || typeof args.newText !== "string") return args;
  const { oldText, newText, ...rest } = args;
  const edits = Array.isArray(rest.edits) ? [...rest.edits] : [];
  edits.push({ oldText, newText });
  return { ...rest, edits };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSingleEdit(value: unknown): value is EditFileToolEdit {
  return isRecord(value) && typeof value.oldText === "string" && typeof value.newText === "string";
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const HOME_PREFIX = /^(?:~|\$HOME)(?=\/|$)/u;

/**
 * Resolves like pi: Unicode spaces, a leading `@`, `~`, and `file://` URLs,
 * then from the workspace root. `$HOME` also works, as in eve's other file tools.
 */
async function resolveEditPath(sandbox: SandboxSession, path: string): Promise<string> {
  let normalized = path.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  const home = HOME_PREFIX.exec(normalized)?.[0];
  if (home !== undefined) {
    const probe = await sandbox.run({ command: `printf '%s' "$HOME"` });
    const dir = probe.exitCode === 0 ? probe.stdout.trim() : "";
    if (dir === "") throw new Error(`Could not edit file: ${path}. The sandbox has no $HOME.`);
    normalized = `${dir === "/" ? "" : dir}${normalized.slice(home.length)}` || "/";
  } else if (normalized.startsWith("file://")) {
    normalized = decodeURIComponent(new URL(normalized).pathname);
  }
  return sandbox.resolvePath(normalized);
}

const fileMutationQueues = new Map<string, Promise<void>>();

/** Serializes edits to one file; edits to different files still run in parallel. */
async function withFileMutationQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = fileMutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  fileMutationQueues.set(key, queued);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (fileMutationQueues.get(key) === queued) fileMutationQueues.delete(key);
  }
}

function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalizes text for fuzzy matching: strips trailing whitespace from each
 * line and maps smart quotes, Unicode dashes, and special spaces to ASCII.
 */
function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // U+2010 hyphen through U+2015 horizontal bar, and U+2212 minus.
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

interface LineSpan {
  start: number;
  end: number;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;

  const startLine = lines.findIndex(
    (line) => replacementStart >= line.start && replacementStart < line.end,
  );
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }

  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }

  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]!;
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.substring(0, matchIndex) +
      replacement.newText +
      result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

/**
 * Applies replacements matched against a fuzzy-normalized `baseContent` to
 * `originalContent`: only the lines a replacement touches are rewritten from
 * the normalized base, and every other line keeps its original bytes.
 */
function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      "Cannot preserve unchanged lines because the base content has a different line count.",
    );
  }

  const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
  const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups.at(-1);
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");

    const groupStartOffset = baseLines[group.startLine]!.start;
    const groupEndOffset = baseLines[group.endLine - 1]!.end;
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");

  return result;
}

interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
}

/** Finds oldText exactly, then in fuzzy-normalized space, where offsets refer to normalized content. */
function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
  }

  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = normalizeForFuzzyMatch(content).indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  }
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  );
}

function getDuplicateError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`oldText must not be empty in ${path}.`);
  }
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Applies exact-text replacements to LF-normalized content. Every edit is
 * matched against the same original content. When any edit needs fuzzy
 * matching, all of them are matched in fuzzy-normalized space and the touched
 * lines are overlaid onto the original, so unchanged lines keep their bytes.
 */
function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: readonly EditFileToolEdit[],
  path: string,
): string {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i]!.oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  const usedFuzzyMatch = normalizedEdits.some(
    (edit) => fuzzyFindText(normalizedContent, edit.oldText).usedFuzzyMatch,
  );
  const replacementBaseContent = usedFuzzyMatch
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]!;
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length);
    }

    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1]!;
    const current = matchedEdits[i]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(
        normalizedContent,
        replacementBaseContent,
        matchedEdits,
      )
    : applyReplacements(replacementBaseContent, matchedEdits);

  if (normalizedContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }
  return newContent;
}
