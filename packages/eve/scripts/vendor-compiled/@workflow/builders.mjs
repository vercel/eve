import { createDeclarationCopier } from "../_shared.mjs";

/**
 * Only `transform-utils` is vendored: the Workflow SDK's directive pre-scan
 * (`findWorkflowPatterns`, `isGeneratedWorkflowFile`), which eve's authored
 * module discovery shares so both sides classify source files identically.
 * The rest of `@workflow/builders` is the SDK's esbuild/SWC build pipeline,
 * which eve replaces with its own bundler and must not ship.
 */
export default {
  packageName: "@workflow/builders",
  compiledPath: "@workflow/builders",
  chunkGroup: "workflow",
  entry: "dist/transform-utils.js",
  copyDeclarations: createDeclarationCopier({
    files: [{ source: "transform-utils.d.ts", output: "index.d.ts" }],
  }),
};
