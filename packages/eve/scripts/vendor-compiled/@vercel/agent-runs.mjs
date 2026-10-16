import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { collectFilesRecursively, createDeclarationCopier } from "../_shared.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tscPath = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const packageRoot = dirname(require.resolve("@vercel/agent-runs/package.json"));
const sources = (await collectFilesRecursively(join(packageRoot, "src"), [".ts"]))
  .filter((file) => !file.endsWith(".test.ts"))
  .map((file) => relative(packageRoot, file).replaceAll("\\", "/"))
  .sort();

const copyDeclarations = createDeclarationCopier({
  declarationRoot: "dist/src",
  files: async ({ distDir }) =>
    (await collectFilesRecursively(distDir, [".d.ts"]))
      .map((file) => relative(distDir, file).replaceAll("\\", "/"))
      .sort()
      .map((file) => ({ source: file, output: file })),
  rewrites: {
    "@opentelemetry/api": { kind: "vendored", compiledPath: "@opentelemetry/api" },
    ai: { kind: "external" },
  },
});

/**
 * Bundle the agent run library so the published eve package
 * stays self-contained. It shares the `workflow` chunk group with the vendored
 * `@opentelemetry/api`, so eve and the library use one OpenTelemetry copy.
 */
export default {
  packageName: "@vercel/agent-runs",
  compiledPath: "@vercel/agent-runs",
  chunkGroup: "workflow",
  entries: ["index", "delegation", "otel", "ai-sdk"].map((name) => ({
    entry: `src/${name}.ts`,
    outputPath: name,
  })),
  fingerprintFiles: [
    "../../tsconfig.json",
    "package.json",
    "tsconfig.build.json",
    "tsconfig.json",
    ...sources,
  ],
  copyDeclarations: async (context) => {
    await execFileAsync(
      process.execPath,
      [tscPath, "-p", "tsconfig.build.json", "--emitDeclarationOnly", "--declarationMap", "false"],
      { cwd: context.packageInfo.packageRoot },
    );
    await copyDeclarations(context);
  },
};
