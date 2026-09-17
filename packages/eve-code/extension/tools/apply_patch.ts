import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import {
  onlyNewTypeDiagnostics,
  runPostEditDiagnostics,
  runTypeScriptDiagnostics,
  type PostEditDiagnostic,
} from "../lib/diagnostics.ts";
import { findGeneratedPatchTargets, generatedPatchTargetsError } from "../lib/generated-paths.ts";
import { applyPatchToSandbox } from "../lib/patch.ts";
import { validateRepositoryRoot } from "../lib/repository-root.ts";

const DiagnosticSchema = z.object({
  check: z.enum(["git-diff", "syntax", "typescript", "whitespace"]),
  code: z.number().int().optional(),
  column: z.number().int().optional(),
  line: z.number().int().optional(),
  message: z.string(),
  path: z.string().optional(),
});

export default defineTool({
  description: [
    "Apply targeted changes inside a git checkout in the sandbox workspace.",
    "Use this instead of rewriting complete files or writing through bash.",
    "Write small hunks against current file contents. If a hunk misses, re-read that file and rewrite only the failed hunk. Do not retry the same patch text.",
    "The patch is fully parsed and every source file is verified before any write.",
    "After writing, the tool runs bounded whitespace, syntax, and TypeScript checks and",
    "returns only diagnostics the patch introduced.",
    "Patch format:",
    "*** Begin Patch",
    "*** Add File: path (every content line starts with +)",
    "*** Update File: path (optional *** Move to: new-path, followed by @@ chunks)",
    "*** Delete File: path",
    "*** End Patch",
    "Paths are relative to the repository and may not escape it.",
    "Generated files (lockfiles, dist/, vendor-compiled/) are rejected: change them",
    "through the command that generates them, never through a patch.",
  ].join("\n"),
  approval: never(),
  label: {
    start: ({ root }) => `Patch ${root}`,
  },
  inputSchema: z.object({
    root: z.string().min(1).describe("absolute git checkout root inside the sandbox workspace"),
    patchText: z.string().min(1).max(500_000).describe("complete *** Begin Patch text"),
  }),
  outputSchema: z.object({
    diagnostics: z.array(DiagnosticSchema),
    files: z.array(
      z.object({
        operation: z.enum(["add", "delete", "move", "update"]),
        path: z.string(),
        previousPath: z.string().optional(),
      }),
    ),
  }),
  async execute({ root, patchText }, ctx) {
    const generatedTargets = findGeneratedPatchTargets(patchText);
    if (generatedTargets.length > 0) {
      throw new Error(generatedPatchTargetsError(generatedTargets));
    }
    const sandbox = await ctx.getSandbox();
    const repoRoot = await validateRepositoryRoot(sandbox, root);

    let baseline: readonly PostEditDiagnostic[] = [];
    const files = await applyPatchToSandbox({
      async beforeCommit(planned) {
        baseline = await runTypeScriptDiagnostics({
          paths: planned.filter((file) => file.operation === "update").map((file) => file.path),
          repoRoot,
          sandbox,
        });
      },
      patchText,
      repoRoot,
      sandbox,
    });

    const changedPaths = files.filter((f) => f.operation !== "delete").map((f) => f.path);
    const addedPaths = files
      .filter((f) => f.operation === "add" || f.operation === "move")
      .map((f) => f.path);
    const deletedPaths = [
      ...files.filter((f) => f.operation === "delete").map((f) => f.path),
      ...files.flatMap((f) =>
        f.operation === "move" && f.previousPath !== undefined ? [f.previousPath] : [],
      ),
    ];
    const diagnostics = onlyNewTypeDiagnostics(
      await runPostEditDiagnostics({ addedPaths, changedPaths, deletedPaths, repoRoot, sandbox }),
      baseline,
    );
    return { diagnostics, files };
  },
});
