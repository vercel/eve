import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";

/**
 * Emits declarations for an extension source tree using the extension's own
 * TypeScript installation and authored tsconfig when available.
 */
export async function emitExtensionDeclarations(input: {
  readonly appRoot: string;
  readonly sourceRoot: string;
  readonly declarationsRoot: string;
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
