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
  if (build.options.stripInternal)
    issues.push(
      ...findStrippedReferences(
        checker,
        program,
        new Map([...entries, ...internalEntries]),
        emitted,
      ),
    );
  return issues;
}

/**
 * eve builds its declarations with `stripInternal`, which drops every node whose leading comment
 * says `@internal`. A kept declaration that still names a dropped one leaves the package with a
 * missing name, so this walks what declaration emit keeps, from every emitted file's exports, and
 * reports each reference to a dropped declaration. It reads the source program instead of emitting.
 */
export function findStrippedReferences(checker, program, entries, emitted) {
  const issues = [];
  const walked = new Set();
  const queue = [];
  const seenTypes = new Set();
  const isEveSource = (file) => emitted.has(file.fileName);
  // A variable's doc comment sits on its statement, which is what `stripInternal` drops.
  const isStripped = (node) =>
    ts.isInternalDeclaration(
      ts.isVariableDeclaration(node) ? node.parent.parent : node,
      node.getSourceFile(),
    );
  const report = (node, message) => {
    const file = node.getSourceFile();
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    issues.push({ rule: 56, file: relative(root, file.fileName), line, message });
  };
  const target = (symbol) =>
    symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const use = (symbol, site) => {
    for (const declaration of target(symbol)?.declarations ?? []) {
      if (!isEveSource(declaration.getSourceFile())) continue;
      if (!isStripped(declaration)) queue.push(declaration);
      else
        report(
          site,
          `names ${symbol.name}, which is tagged @internal. stripInternal drops it from eve's emitted declarations, so this kept declaration would name a missing type. Document ${symbol.name} and drop @internal, tag the referencing declaration @internal too, or stop naming it here.`,
        );
    }
  };
  // Declaration emit prints an unannotated declaration's inferred type, which can name declarations.
  const useType = (type, site, depth = 0) => {
    if (type === undefined || depth > 4 || seenTypes.has(type)) return;
    seenTypes.add(type);
    for (const symbol of [type.aliasSymbol, type.getSymbol()]) {
      const named = symbol?.declarations?.some(
        (node) =>
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isEnumDeclaration(node) ||
          ts.isFunctionDeclaration(node),
      );
      if (named) use(symbol, site);
    }
    const nested = [...(type.aliasTypeArguments ?? [])];
    if (type.isUnionOrIntersection()) nested.push(...type.types);
    if (type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Reference)
      nested.push(...checker.getTypeArguments(type));
    for (const item of nested) useType(item, site, depth + 1);
  };
  const walk = (node) => {
    if (ts.isInternalDeclaration(node, node.getSourceFile())) return;
    if (ts.isPrivateIdentifier(node.name ?? node)) return;
    if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)) return;
    if (ts.isTypeReferenceNode(node)) use(checker.getSymbolAtLocation(node.typeName), node);
    else if (ts.isExpressionWithTypeArguments(node))
      use(checker.getSymbolAtLocation(node.expression), node);
    else if (ts.isTypeQueryNode(node)) use(checker.getSymbolAtLocation(node.exprName), node);
    else if (ts.isExportSpecifier(node)) use(checker.getSymbolAtLocation(node.name), node);
    else if (
      ts.isIndexedAccessTypeNode(node) &&
      ts.isLiteralTypeNode(node.indexType) &&
      ts.isStringLiteral(node.indexType.literal)
    ) {
      const object = checker.getTypeFromTypeNode(node.objectType);
      use(checker.getPropertyOfType(object, node.indexType.literal.text), node);
    }
    if (ts.isExportAssignment(node)) {
      useType(checker.getTypeAtLocation(node.expression), node);
      return;
    }
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isGetAccessorDeclaration(node)) &&
      node.type === undefined
    )
      useType(checker.getTypeAtLocation(node.name), node);
    else if (
      ts.isFunctionLike(node) &&
      node.type === undefined &&
      !ts.isConstructorDeclaration(node)
    )
      useType(checker.getSignatureFromDeclaration(node)?.getReturnType(), node);
    // Code bodies and initializers never reach declarations; inferred types were handled above.
    const body = ts.isModuleDeclaration(node) ? undefined : node.body;
    ts.forEachChild(node, (child) => {
      if (child !== body && child !== node.initializer) walk(child);
    });
  };
  // Every emitted file keeps its exports and module augmentations; the rest is kept when referenced.
  for (const fileName of emitted) {
    for (const statement of program.getSourceFile(fileName)?.statements ?? []) {
      if (
        ts.isExportDeclaration(statement) ||
        ts.isExportAssignment(statement) ||
        ts.isModuleDeclaration(statement) ||
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
        queue.push(statement);
    }
  }
  // `export *` drops a stripped name silently, so the entry's export list would claim a missing name.
  for (const [entry, source] of entries) {
    const sourceFile = program.getSourceFile(source);
    const module = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (module === undefined) continue;
    for (const exported of checker.getExportsOfModule(module)) {
      if (exported.declarations?.some(ts.isExportSpecifier)) continue;
      for (const declaration of exported.declarations ?? []) {
        if (isEveSource(declaration.getSourceFile()) && isStripped(declaration))
          report(
            declaration,
            `is exported from ${entry} but tagged @internal, so stripInternal drops it from the entry's declarations. Document it and drop @internal, or stop exporting it.`,
          );
      }
    }
  }
  while (queue.length > 0) {
    const declaration = queue.pop();
    if (walked.has(declaration)) continue;
    walked.add(declaration);
    walk(declaration);
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
