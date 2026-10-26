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
  for (const [key, value] of Object.entries(manifest.exports)) {
    if (key === "./internal" || key.startsWith("./internal/")) continue;
    const declaration = typeof value === "object" ? value.types : value;
    if (typeof declaration !== "string" || !declaration.endsWith(".d.ts")) continue;
    const source = join(eve, declaration.replace(/^\.\/dist\//, ""));
    const implementation = source.replace(/\.d\.ts$/, ".ts");
    entries.set(
      key === "." ? "eve" : `eve${key.slice(1)}`,
      ts.sys.fileExists(implementation) ? implementation : source,
    );
  }
  const program = ts.createProgram([...entries.values()], {
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
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some((arg) => arg !== "--write"))
    throw new Error("Usage: node scripts/public-exports.mjs [--write]");
  const write = process.argv.includes("--write");
  const issues = await checkPublicExports({ write });
  if (issues.length > 0) {
    for (const issue of issues) process.stderr.write(`${issue.file}: ${issue.message}\n`);
    process.exitCode = 1;
  } else
    process.stdout.write(
      `[eve:public-exports] ${write ? "updated" : "ok"} — public named export lists match.\n`,
    );
}
