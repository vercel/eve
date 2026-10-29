/**
 * Writes `docs/SOURCE_MAP.json`: every public export of each package subpath,
 * mapped to the `.d.ts` line that declares it (JSDoc included) and, for
 * runtime values, the `.js` module that implements it. Coding agents use it to
 * jump straight to a declaration instead of grepping through `dist/`.
 *
 * Runs after `build-js.mjs` and `copy-docs.mjs`, because it reads the emitted
 * declarations and writes into the copied package docs.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const nitroRequire = createRequire(createRequire(import.meta.url).resolve("nitro/package.json"));
const { parseSync } = await import(pathToFileURL(nitroRequire.resolve("rolldown/utils")).href);

const VALUE_KINDS = new Set(["function", "const", "class", "enum", "namespace"]);
const modules = new Map();

function isPublicSubpath(subpath) {
  return subpath !== "./package.json" && !subpath.startsWith("./internal/");
}

function loadModule(file) {
  let module = modules.get(file);
  if (module !== undefined) return module;
  const source = readFileSync(file, "utf8");
  const { program, comments, errors } = parseSync(file, source, { lang: "dts" });
  if (errors.length > 0) {
    throw new Error(`Cannot parse ${file}: ${errors[0].message}`);
  }
  const lineStarts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }
  module = { file, source, program, comments, lineStarts, locals: new Map(), exports: null };
  modules.set(file, module);
  collectLocals(module);
  return module;
}

function lineOf(module, offset) {
  let low = 0;
  let high = module.lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (module.lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

// Point at the JSDoc block directly above a declaration so reading from the
// mapped line shows the documentation first.
function declarationLine(module, node) {
  const doc = module.comments.findLast(
    (comment) =>
      comment.type === "Block" &&
      comment.value.startsWith("*") &&
      comment.end <= node.start &&
      module.source.slice(comment.end, node.start).trim() === "",
  );
  return lineOf(module, doc?.start ?? node.start);
}

function kindOf(declaration) {
  switch (declaration.type) {
    case "FunctionDeclaration":
    case "TSDeclareFunction":
      return "function";
    case "VariableDeclaration":
      return "const";
    case "ClassDeclaration":
      return "class";
    case "TSInterfaceDeclaration":
      return "interface";
    case "TSTypeAliasDeclaration":
      return "type";
    case "TSEnumDeclaration":
      return "enum";
    case "TSModuleDeclaration":
      return "namespace";
    default:
      return null;
  }
}

function declaredNames(declaration) {
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations.map((declarator) => declarator.id.name);
  }
  const name = declaration.id?.name ?? declaration.id?.value;
  return name === undefined ? [] : [name];
}

function collectLocals(module) {
  for (const statement of module.program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration === null) continue;
    if (declaration.type === "ImportDeclaration") {
      for (const specifier of declaration.specifiers) {
        const imported =
          specifier.type === "ImportSpecifier"
            ? (specifier.imported.name ?? specifier.imported.value)
            : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : "*";
        module.locals.set(specifier.local.name, {
          import: { source: declaration.source.value, name: imported },
        });
      }
      continue;
    }
    const kind = kindOf(declaration);
    if (kind === null) continue;
    for (const name of declaredNames(declaration)) {
      // Keep the first overload; it is where the JSDoc usually sits.
      if (!module.locals.has(name)) {
        module.locals.set(name, {
          kind,
          file: module.file,
          line: declarationLine(module, statement),
        });
      }
    }
  }
}

function resolveSpecifier(fromFile, specifier) {
  let target;
  if (specifier.startsWith(".")) {
    target = resolve(dirname(fromFile), specifier);
  } else if (specifier.startsWith("#compiled/")) {
    target = join(packageRoot, "dist/src/compiled", specifier.slice("#compiled/".length));
  } else if (specifier.startsWith("#")) {
    target = join(packageRoot, "dist/src", specifier.slice(1));
  } else {
    return null;
  }
  const candidates = [
    target.replace(/\.[jt]s$/u, ".d.ts"),
    target.replace(/\.mjs$/u, ".d.mts"),
    `${target}.d.ts`,
    join(target, "index.d.ts"),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (file === undefined) throw new Error(`Cannot resolve ${specifier} from ${fromFile}`);
  return file;
}

function resolveBinding(module, name, seen = new Set()) {
  const key = `${module.file}\0${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const local = module.locals.get(name);
  if (local === undefined) {
    return exportsOf(module).get(name) ?? null;
  }
  if (local.import === undefined) return local;
  return resolveImport(module.file, local.import.source, local.import.name, seen);
}

function resolveImport(fromFile, specifier, name, seen) {
  const file = resolveSpecifier(fromFile, specifier);
  if (file === null) return { kind: "external", from: specifier };
  const target = loadModule(file);
  if (name === "*") return { kind: "namespace", file, line: 1 };
  return exportsOf(target).get(name) ?? resolveBinding(target, name, seen);
}

function exportsOf(module) {
  if (module.exports !== null) return module.exports;
  const exports = new Map();
  module.exports = exports;
  for (const statement of module.program.body) {
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration !== null) {
        for (const name of declaredNames(statement.declaration)) {
          exports.set(name, module.locals.get(name));
        }
        continue;
      }
      for (const specifier of statement.specifiers) {
        const local = specifier.local.name ?? specifier.local.value;
        const exported = specifier.exported.name ?? specifier.exported.value;
        const binding =
          statement.source === null
            ? resolveBinding(module, local)
            : resolveImport(module.file, statement.source.value, local, new Set());
        if (binding !== null) exports.set(exported, binding);
      }
    } else if (statement.type === "ExportAllDeclaration") {
      const file = resolveSpecifier(module.file, statement.source.value);
      if (statement.exported !== null) {
        const name = statement.exported.name ?? statement.exported.value;
        exports.set(
          name,
          file === null
            ? { kind: "external", from: statement.source.value }
            : { kind: "namespace", file, line: 1 },
        );
        continue;
      }
      if (file === null) continue;
      for (const [name, binding] of exportsOf(loadModule(file))) {
        if (name !== "default" && !exports.has(name)) exports.set(name, binding);
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      const binding =
        declaration.type === "Identifier"
          ? resolveBinding(module, declaration.name)
          : {
              kind: kindOf(declaration) ?? "const",
              file: module.file,
              line: declarationLine(module, statement),
            };
      if (binding !== null) exports.set("default", binding);
    }
  }
  return exports;
}

function toEntry(binding) {
  if (binding.kind === "external") return { kind: "re-export", from: binding.from };
  const types = relative(packageRoot, binding.file);
  const entry = { kind: binding.kind, types: `${types}:${binding.line}` };
  const implementation = types.replace(/\.d\.ts$/u, ".js");
  if (VALUE_KINDS.has(binding.kind) && existsSync(join(packageRoot, implementation))) {
    entry.implementation = implementation;
  }
  return entry;
}

// Name -> one entry per distinct declaration, listing every import path that
// exports it. Most names come from one declaration re-exported by several
// subpaths; a few (`default`, `useEveAgent`) have one per subpath.
const declarations = new Map();
for (const [subpath, target] of Object.entries(packageJson.exports)) {
  if (!isPublicSubpath(subpath) || typeof target.types !== "string") continue;
  const importPath = subpath === "." ? "eve" : `eve/${subpath.slice(2)}`;
  for (const [name, binding] of exportsOf(loadModule(join(packageRoot, target.types)))) {
    const entry = toEntry(binding);
    const key = entry.types ?? entry.from;
    const byDeclaration = declarations.get(name) ?? new Map();
    declarations.set(name, byDeclaration);
    const existing = byDeclaration.get(key);
    if (existing === undefined) byDeclaration.set(key, { import: [importPath], ...entry });
    else existing.import.push(importPath);
  }
}

// One export per line keeps the file grep-friendly:
// `grep '"defineTool"' node_modules/eve/docs/SOURCE_MAP.json`.
const entries = [...declarations]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([name, byDeclaration]) =>
      `    ${JSON.stringify(name)}: ${JSON.stringify([...byDeclaration.values()])}`,
  );
const output = [
  "{",
  `  "note": "Each public export of the eve package: the import paths that export it, the .d.ts declaration (paths are relative to the installed package; the line points at its JSDoc), and, for runtime values, the minified module that implements it.",`,
  `  "exports": {`,
  entries.join(",\n"),
  "  }",
  "}",
  "",
];
await writeFile(join(packageRoot, "docs", "SOURCE_MAP.json"), output.join("\n"));
