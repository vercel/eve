import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = createRequire(require.resolve("@microsoft/api-extractor/package.json"))("typescript");
const root = fileURLToPath(new URL("../", import.meta.url));
const eve = join(root, "packages/eve");
const snapshots = join(eve, "public-api");

export async function checkPublicExports({ write = false } = {}) {
  execFileSync(process.execPath, [join(eve, "scripts/vendor-compiled.mjs")], {
    cwd: eve,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const manifest = JSON.parse(await readFile(join(eve, "package.json"), "utf8"));
  const entries = new Map();
  // Internal entries have no export snapshot, but other packages still read their declarations.
  const internalEntries = new Map();
  for (const [key, value] of Object.entries(manifest.exports)) {
    const declaration = typeof value === "object" ? value.types : value;
    if (typeof declaration !== "string" || !declaration.endsWith(".d.ts")) continue;
    const source = join(eve, declaration.replace(/^\.\/dist\//, ""));
    const implementation = source.replace(/\.d\.ts$/, ".ts");
    const entry = key === "." ? "eve" : `eve${key.slice(1)}`;
    if (key === "./internal" || key.startsWith("./internal/")) {
      if (ts.sys.fileExists(implementation)) internalEntries.set(entry, implementation);
      continue;
    }
    entries.set(entry, ts.sys.fileExists(implementation) ? implementation : source);
  }
  const build = ts.getParsedCommandLineOfConfigFile(join(eve, "tsconfig.build.json"), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  const emitted = new Set(build.fileNames);
  const program = ts.createProgram([...entries.values(), ...emitted], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    customConditions: ["eve-source"],
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const issues = [];
  const expectedPaths = new Set();
  for (const [entry, source] of entries) {
    const file = join(snapshots, `${entry}.json`);
    expectedPaths.add(file);
    const sourceFile = program.getSourceFile(source);
    if (sourceFile === undefined)
      throw new Error(`Public entry ${entry} has no source at ${source}.`);
    const symbol = checker.getSymbolAtLocation(sourceFile);
    const names =
      symbol === undefined
        ? []
        : checker
            .getExportsOfModule(symbol)
            .map((item) => item.name)
            .sort();
    const content = `${JSON.stringify(names, null, 2)}\n`;
    if (write) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
      continue;
    }
    const previous = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (previous !== undefined && JSON.stringify(JSON.parse(previous)) === JSON.stringify(names))
      continue;
    const before = new Set(previous === undefined ? [] : JSON.parse(previous));
    const after = new Set(names);
    const added = names.filter((name) => !before.has(name));
    const removed = [...before].filter((name) => !after.has(name));
    issues.push({
      file: relative(root, file),
      message: `${entry} export list changed (added: ${added.join(", ") || "none"}; removed: ${removed.join(", ") || "none"}). Review the API change and run node scripts/public-exports.mjs --write.`,
    });
  }
  const files = await readdir(snapshots, { recursive: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const file = join(snapshots, name);
    if (expectedPaths.has(file)) continue;
    if (write) await rm(file);
    else
      issues.push({
        file: relative(root, file),
        message:
          "Export list has no public package entry. Review its removal and run node scripts/public-exports.mjs --write.",
      });
  }
  // Dangling references to stripped declarations are caught by
  // packages/eve/test/scenarios/packed-public-types.scenario.test.ts.
  if (build.options.stripInternal)
    issues.push(
      ...findInternalExports(checker, program, new Map([...entries, ...internalEntries]), emitted),
    );
  return issues;
}

/**
 * eve builds its declarations with `stripInternal`, which drops every node whose leading comment
 * says `@internal`. An entry that exports such a name would list it in its snapshot while its
 * declarations no longer contain it (`export *` drops it silently).
 */
export function findInternalExports(checker, program, entries, emitted) {
  const issues = [];
  // A variable's doc comment sits on its statement, which is what `stripInternal` drops.
  const isStripped = (node) =>
    ts.isInternalDeclaration(
      ts.isVariableDeclaration(node) ? node.parent.parent : node,
      node.getSourceFile(),
    );
  for (const [entry, source] of entries) {
    const sourceFile = program.getSourceFile(source);
    const module = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (module === undefined) continue;
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      // Declaration emit drops an overload implementation, so only the signatures count, and an
      // export survives as long as one of them is kept.
      const declarations = (symbol.declarations ?? []).filter(
        (node) => !(ts.isFunctionDeclaration(node) && node.body && symbol.declarations.length > 1),
      );
      if (
        declarations.length === 0 ||
        !declarations.every(
          (node) => emitted.has(node.getSourceFile().fileName) && isStripped(node),
        )
      )
        continue;
      const node = declarations[0];
      const file = node.getSourceFile();
      issues.push({
        file: relative(root, file.fileName),
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        message: `${exported.name} is exported from ${entry} but tagged @internal, so stripInternal drops it from the entry's declarations. Document it and drop @internal, or stop exporting it.`,
      });
    }
  }
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some((arg) => arg !== "--write"))
    throw new Error("Usage: node scripts/public-exports.mjs [--write]");
  const write = process.argv.includes("--write");
  const issues = await checkPublicExports({ write });
  if (issues.length > 0) {
    for (const issue of issues)
      process.stderr.write(
        `${issue.file}${issue.line ? `:${issue.line}` : ""}: ${issue.message}\n`,
      );
    process.exitCode = 1;
  } else
    process.stdout.write(
      `[eve:public-exports] ${write ? "updated" : "ok"} — public named export lists match.\n`,
    );
}
