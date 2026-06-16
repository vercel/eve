import { createDeclarationCopier } from "../_shared.mjs";

/**
 * Stub for `ms`. Upstream `@workflow/errors` imports only the
 * `StringValue` type — a union of duration-string literals like
 * `"5 seconds"`. Aliasing to `string` loses the literal narrowing but
 * keeps every signature in `@workflow/errors` valid for eve and any
 * consumer that touches `retryAfter`.
 */
function buildMsStub(names, moduleName) {
  const lines = [
    `// Auto-generated stub for \`${moduleName}\` types referenced by a vendored .d.ts.`,
    `// Emitted by scripts/vendor-compiled/@workflow/errors.mjs.`,
    ``,
  ];
  for (const name of [...names].sort()) {
    if (name === "StringValue") {
      lines.push(`export type StringValue = string;`);
    } else {
      lines.push(`export type ${name} = unknown;`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Type declarations are copied verbatim from the installed
 * @workflow/errors version so the error class hierarchy eve exposes
 * (`WorkflowRunNotFoundError`, `WorkflowWorldError`, …) tracks the real
 * upstream surface without a hand-written stub that has to be kept in
 * sync on every bump.
 *
 * Co-copies `error-codes.d.ts` (re-exported by `index.d.ts` via
 * `./error-codes.js`). The two unused-by-eve entry-point declarations
 * (`ansi.d.ts`, `internal-chalk.d.ts`) are intentionally not copied —
 * they describe sub-paths eve never imports.
 */
export default {
  packageName: "@workflow/errors",
  compiledPath: "@workflow/errors",
  chunkGroup: "workflow",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      ms: { kind: "stub", stubBaseName: "_ms", build: buildMsStub },
    },
    discoverExtraFiles: (distEntries) => distEntries.filter((name) => name === "error-codes.d.ts"),
  }),
};
