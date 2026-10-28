import { format } from "prettier";
import ts from "typescript";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
const files = [
  "packages/browser-runtime/src/index.ts",
  "packages/protocol/src/index.ts",
  "packages/sdk/src/index.ts",
  "apps/cli/src/index.ts",
];
for (const file of files) {
  const output = file.replace("/src/", "/dist/").replace(/\.ts$/, ".js");
  const compiled = ts.transpileModule(await readFile(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      rewriteRelativeImportExtensions: true,
      verbatimModuleSyntax: true,
    },
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, compiled.outputText);
  if (file === "apps/cli/src/index.ts") await chmod(output, 0o755);
}
await writeFile(
  "packages/start/desktop/runtime/runner.mjs",
  // Match the repository formatter (oxfmt) so the committed runtime stays byte-stable.
  await format(await readFile("packages/browser-runtime/dist/index.js", "utf8"), {
    parser: "babel",
    printWidth: 100,
  }),
);
console.log("Built Eve libraries and CLI.");

const { build } = await import("esbuild");
await build({
  entryPoints: ["packages/start/web/app.js"],
  bundle: true,
  outfile: "packages/start/web/dist/app.js",
  format: "esm",
  target: "es2022",
  minify: true,
});

await import("../packages/start/build.mjs");
await build({
  entryPoints: ["apps/cli/src/index.ts"],
  bundle: true,
  outfile: "apps/cli/dist/index.js",
  format: "esm",
  platform: "node",
  target: "node24",
  conditions: ["development"],
  external: ["agent-browser/*"],
});
await chmod("apps/cli/dist/index.js", 0o755);
