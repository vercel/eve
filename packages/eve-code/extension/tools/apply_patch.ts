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
import { resolveWorkspaceDirectory } from "../lib/workspace-root.ts";

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
    "Edit files in the sandbox with a patch. Prefer it over rewriting whole files or writing through bash.",
    "Keep hunks small and based on current file contents. Nothing is written unless every hunk applies; if one misses, re-read the file and resend the whole corrected patch.",
    "Returns the files changed and any problems the patch introduced (whitespace, syntax, TypeScript).",
    "Paths are relative to root and cannot escape it. Generated files such as lockfiles and dist/ are rejected; regenerate them with their command.",
    "Format:",
    "*** Begin Patch",
    "*** Add File: path (every content line starts with +)",
    "*** Update File: path (optional *** Move to: new-path, followed by @@ chunks)",
    "*** Delete File: path",
    "*** End Patch",
  ].join("\n"),
  approval: never(),
  label: {
    start: ({ root }) => `Patch ${root ?? "workspace"}`,
  },
  inputSchema: z.object({
    root: z
      .string()
      .min(1)
      .optional()
      .describe(
        "absolute directory inside the sandbox workspace that patch paths are relative to; defaults to the workspace root",
      ),
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
    const patchRoot = await resolveWorkspaceDirectory(sandbox, root);

    let baseline: readonly PostEditDiagnostic[] = [];
    const previousContents = new Map<string, string | null>();
    const files = await applyPatchToSandbox({
      async beforeCommit(planned) {
        for (const file of planned) previousContents.set(file.path, file.previousContent);
        baseline = await runTypeScriptDiagnostics({
          paths: planned.filter((file) => file.operation === "update").map((file) => file.path),
          patchRoot,
          sandbox,
        });
      },
      patchText,
      patchRoot,
      sandbox,
      sessionId: ctx.session.id,
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
      await runPostEditDiagnostics({
        addedPaths,
        changedPaths,
        deletedPaths,
        patchRoot,
        previousContents,
        sandbox,
      }),
      baseline,
    );
    return { diagnostics, files };
  },
});
