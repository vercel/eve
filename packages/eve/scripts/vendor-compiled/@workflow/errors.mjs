import { createDeclarationCopier } from "../_shared.mjs";

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

export default {
  packageName: "@workflow/errors",
  compiledPath: "@workflow/errors",
  chunkGroup: "workflow",
  platform: "neutral",
  entries: [{ outputPath: "index" }, { input: "@workflow/errors/ansi", outputPath: "ansi" }],
  sharedSpecifiers: { "@workflow/errors": "index", "@workflow/errors/ansi": "ansi" },
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      ms: { kind: "stub", stubBaseName: "_ms", build: buildMsStub },
    },
    discoverExtraFiles: (distEntries) =>
      distEntries.filter((name) => name === "error-codes.d.ts" || name === "ansi.d.ts"),
  }),
};
