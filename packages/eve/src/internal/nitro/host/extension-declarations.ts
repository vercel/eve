import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";

/**
 * Emits declarations for an extension source tree using the extension's own
 * TypeScript installation and authored tsconfig when available.
 */
export async function emitExtensionDeclarations(input: {
  readonly appRoot: string;
  readonly declarationsRoot: string;
  readonly moduleLogicalPaths: readonly string[];
  readonly sourceRoot: string;
}): Promise<void> {
  const tscBinary = await resolveTypeScriptBinary(input.appRoot);
  const tsconfigPath = join(input.appRoot, "tsconfig.json");
  const hasTsConfig = await stat(tsconfigPath)
    .then((entry) => entry.isFile())
    .catch(() => false);
  const sharedArguments = [
    "--declaration",
    "--emitDeclarationOnly",
    "--noEmit",
    "false",
    "--noEmitOnError",
    "true",
    "--rootDir",
    input.appRoot,
    "--outDir",
    input.declarationsRoot,
    "--pretty",
    "false",
  ];
  const arguments_ = hasTsConfig
    ? ["--project", tsconfigPath, ...sharedArguments]
    : [
        ...sharedArguments,
        "--allowJs",
        "--checkJs",
        "false",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--target",
        "ES2022",
        "--skipLibCheck",
        "true",
        ...(await collectDeclarationInputs(input.sourceRoot)),
      ];

  try {
    await promisify(execFile)(process.execPath, [tscBinary, ...arguments_], {
      cwd: input.appRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const output = declarationEmitOutput(error);
    throw new Error(
      `Cannot emit extension declarations${output.length > 0 ? `:\n${output}` : "."}`,
      { cause: error },
    );
  }

  await assertModuleDeclarationsEmitted(input);
}

async function assertModuleDeclarationsEmitted(input: {
  readonly appRoot: string;
  readonly declarationsRoot: string;
  readonly moduleLogicalPaths: readonly string[];
  readonly sourceRoot: string;
}): Promise<void> {
  const sourceRelativePath = relative(input.appRoot, input.sourceRoot);
  const missing = (
    await Promise.all(
      input.moduleLogicalPaths.map(async (logicalPath) => {
        const declarationPath = join(
          input.declarationsRoot,
          sourceRelativePath,
          declarationLogicalPath(logicalPath),
        );
        const exists = await stat(declarationPath)
          .then((entry) => entry.isFile())
          .catch(() => false);
        return exists ? undefined : logicalPath;
      }),
    )
  ).filter((logicalPath): logicalPath is string => logicalPath !== undefined);

  if (missing.length === 0) return;
  if (missing.length === input.moduleLogicalPaths.length) {
    throw new Error(
      `TypeScript emitted no declarations for "${sourceRelativePath}". Ensure the package tsconfig.json \`include\` covers every module under \`eve.extension.source\`.`,
    );
  }

  const label = missing.length === 1 ? "module" : "modules";
  throw new Error(
    `TypeScript emitted no declaration for extension ${label} ${missing.map((logicalPath) => JSON.stringify(logicalPath)).join(", ")}. Include ${missing.length === 1 ? "it" : "them"} in the package tsconfig.json before publishing the extension.`,
  );
}

function declarationLogicalPath(logicalPath: string): string {
  if (logicalPath.endsWith(".mts") || logicalPath.endsWith(".mjs")) {
    return `${logicalPath.slice(0, -4)}.d.mts`;
  }
  if (logicalPath.endsWith(".cts") || logicalPath.endsWith(".cjs")) {
    return `${logicalPath.slice(0, -4)}.d.cts`;
  }
  if (logicalPath.endsWith(".ts") || logicalPath.endsWith(".js")) {
    return `${logicalPath.slice(0, -3)}.d.ts`;
  }
  throw new Error(`Unsupported extension module path "${logicalPath}".`);
}

async function collectDeclarationInputs(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await collectDeclarationInputs(entryPath)));
    } else if (
      entry.isFile() &&
      SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
    ) {
      paths.push(entryPath);
    }
  }
  return paths.sort();
}

function declarationEmitOutput(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const processError = error as Error & { stdout?: string; stderr?: string };
  return [processError.stdout, processError.stderr, processError.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
}

async function resolveTypeScriptBinary(appRoot: string): Promise<string> {
  for (const from of [join(appRoot, "package.json"), import.meta.url]) {
    let manifestPath: string;
    try {
      manifestPath = createRequire(from).resolve("typescript/package.json");
    } catch {
      continue;
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binField = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.tsc;
    if (binField !== undefined) {
      return join(dirname(manifestPath), binField);
    }
  }
  throw new Error(
    "Cannot build an eve extension without TypeScript. Add `typescript` to the package's devDependencies.",
  );
}
