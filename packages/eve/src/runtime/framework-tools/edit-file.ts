import { z } from "#compiled/zod/index.js";

import { loadContext } from "#context/container.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import { resolveAbsoluteFilePath } from "#execution/sandbox/require-sandbox.js";
import {
  buildReadFileTargetKey,
  createReadFileStamp,
  normalizeModelPath,
  setReadFileStamp,
} from "#runtime/framework-tools/file-state.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/**
 * Typed input accepted by {@link executeEditFile}.
 *
 * Replaces exactly one occurrence of `old_string` with `new_string` in the
 * target file. If `old_string` is not found (or is found more than once), the
 * call fails with a descriptive error and the file is left untouched.
 */
export const EDIT_FILE_INPUT_SCHEMA = z.strictObject({
  filePath: z
    .string()
    .describe("The absolute path to the file to edit. A leading $HOME is supported."),
  oldString: z
    .string()
    .describe(
      "The exact substring to replace. Must appear exactly once in the file. Use enough surrounding context to make the match unique.",
    ),
  newString: z
    .string()
    .describe("The replacement text. The file is rewritten as: before + newString + after."),
});

/**
 * Structured result returned from {@link executeEditFile}.
 */
export const EDIT_FILE_OUTPUT_SCHEMA = z.strictObject({
  path: z.string(),
  replacements: z.number().int(),
});

export interface EditFileInput {
  readonly filePath: string;
  readonly newString: string;
  readonly oldString: string;
}

export interface EditFileResult {
  readonly path: string;
  readonly replacements: number;
}

/**
 * Executor that reads the file, performs the unique-substring replacement,
 * and writes the result back. Fails when the substring is missing or ambiguous.
 */
export async function executeEditFileOnSandbox(
  sandbox: import("#shared/sandbox-session.js").SandboxSession,
  args: EditFileInput,
): Promise<EditFileResult> {
  const resolvedPath = await resolveAbsoluteFilePath(sandbox, args.filePath);

  const current = await sandbox.readTextFile({ path: resolvedPath });
  if (current === null) {
    throw new Error(
      `edit_file: file does not exist at ${resolvedPath}. Use write_file to create it, or check the path.`,
    );
  }

  const oldLen = args.oldString.length;
  if (oldLen === 0) {
    throw new Error("edit_file: oldString must be non-empty.");
  }

  // Count occurrences strictly.
  let occurrences = 0;
  let idx = current.indexOf(args.oldString);
  while (idx >= 0) {
    occurrences += 1;
    idx = current.indexOf(args.oldString, idx + oldLen);
  }

  if (occurrences === 0) {
    throw new Error(
      `edit_file: oldString not found in ${resolvedPath}. The file may have drifted — re-read it with read_file and try again.`,
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `edit_file: oldString matched ${occurrences} times in ${resolvedPath}. Add more surrounding context to make the match unique.`,
    );
  }

  // Perform the guaranteed-unique replacement. Use a replacer function so that
  // `$`-prefixed sequences in `newString` ($$, $&, $`, $', $n) are inserted
  // literally instead of being interpreted as special replacement patterns.
  const next = current.replace(args.oldString, () => args.newString);
  await sandbox.writeTextFile({ content: next, path: resolvedPath });

  // Refresh the read-file stamp so that a subsequent `write_file` on this file
  // does not spuriously fail with "modified since it was last read" — the only
  // mutation was this authorized edit.
  const ctx = loadContext();
  const normalizedPath = normalizeModelPath(resolvedPath);
  const targetKey = buildReadFileTargetKey(normalizedPath);
  setReadFileStamp(ctx, targetKey, createReadFileStamp({ content: next, filePath: normalizedPath }));

  return { path: resolvedPath, replacements: 1 };
}

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
async function executeEditFile(input: unknown, options?: ToolExecuteOptions): Promise<unknown> {
  return executeEditFileOnSandbox(
    await requireSandboxSession(options?.abortSignal),
    input as EditFileInput,
  );
}

/**
 * Framework `edit_file` tool — partial-edit primitive.
 *
 * Use this when the change is localized and the file is already correct
 * around the edit region. It avoids the latency and context bloat of
 * regenerating the entire file through `write_file`.
 */
export const EDIT_FILE_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: [
    "Performs a unique substring replacement in a file. Use when you only need",
    "to edit a small region of an existing file.",
    "",
    "- Fails with a descriptive error if `oldString` is not found or matches more than once.",
    "- Always prefer `edit_file` over `write_file` for targeted changes.",
    "- Use `write_file` when creating a new file or when the change is too large for a unique substring.",
  ].join("\n"),
  execute: executeEditFile,
  inputSchema: EDIT_FILE_INPUT_SCHEMA,
  logicalPath: "eve:framework/edit-file",
  name: "edit_file",
  outputSchema: EDIT_FILE_OUTPUT_SCHEMA,
  sourceId: "eve:edit-file-tool",
  sourceKind: "module",
};
