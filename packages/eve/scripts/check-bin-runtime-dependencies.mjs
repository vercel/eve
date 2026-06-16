import { readFile, readdir } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const runtimeDependencies = new Set(Object.keys(packageJson.dependencies ?? {}));
const binRoot = join(packageRoot, "bin");
const require = createRequire(import.meta.url);
const nitroRequire = createRequire(require.resolve("nitro/package.json"));
const parseAstPath = nitroRequire.resolve("rolldown/parseAst");
const { parseAst } = await import(pathToFileURL(parseAstPath).href);

function packageName(specifier) {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/", 1)[0];
}

function isBarePackageImport(specifier) {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("#") &&
    !specifier.includes(":") &&
    !isBuiltin(specifier)
  );
}

async function* walkJavaScriptFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkJavaScriptFiles(path);
    } else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) {
      yield path;
    }
  }
}

const violations = [];

for await (const path of walkJavaScriptFiles(binRoot)) {
  const source = await readFile(path, "utf8");
  const ast = parseAst(
    source,
    { astType: "ts", lang: "js", range: true, sourceType: "module" },
    relative(packageRoot, path),
  );

  for (const statement of ast.body ?? []) {
    if (statement.type !== "ImportDeclaration" || typeof statement.source.value !== "string") {
      continue;
    }
    const specifier = statement.source.value;
    if (!isBarePackageImport(specifier)) {
      continue;
    }
    const dependency = packageName(specifier);
    if (!runtimeDependencies.has(dependency)) {
      violations.push({ dependency, path: relative(packageRoot, path), specifier });
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    process.stderr.write(
      `${violation.path} imports "${violation.specifier}", but "${violation.dependency}" is not ` +
        "declared in package.json dependencies. eve's bin files ship unbundled, so every bare " +
        "import must be available in production installs.\n",
    );
  }
  process.exit(1);
}

process.stdout.write("[eve:check-bin-runtime-dependencies] ok\n");
