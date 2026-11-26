interface BannerLine {
  readonly importLine: string;
  readonly declarationLine: string;
  readonly bindingName: string;
}

interface ParsedNode {
  readonly body?: ParsedNode | readonly ParsedNode[];
  readonly type: string;
  readonly name?: string;
  readonly declarations?: readonly { readonly id: ParsedNode }[];
}

interface ParsedProgram {
  readonly body: readonly ParsedNode[];
}

const BANNER_LINES: readonly BannerLine[] = [
  {
    importLine: 'import { fileURLToPath as __eveFileURLToPath } from "node:url";',
    declarationLine: "const __filename = __eveFileURLToPath(import.meta.url);",
    bindingName: "__filename",
  },
  {
    importLine: 'import { dirname as __eveDirname } from "node:path";',
    declarationLine: "const __dirname = __eveDirname(__filename);",
    bindingName: "__dirname",
  },
  {
    importLine: 'import { createRequire as __eveCreateRequire } from "node:module";',
    declarationLine: "const require = __eveCreateRequire(import.meta.url);",
    bindingName: "require",
  },
];

const FILENAME_BANNER_LINE = BANNER_LINES[0]!;
const DIRNAME_BANNER_LINE = BANNER_LINES[1]!;
const REQUIRE_BANNER_LINE = BANNER_LINES[2]!;
const STANDALONE_DIRNAME_DECLARATION =
  "const __dirname = __eveDirname(__eveFileURLToPath(import.meta.url));";
const DEAD_BANNER_CALL_LINES = new Set([
  "__eveFileURLToPath(import.meta.url);",
  "__eveDirname(__filename);",
  "__eveDirname(__eveFileURLToPath(import.meta.url));",
  "__eveCreateRequire(import.meta.url);",
]);

const BANNER_LINE_SET = new Set([
  ...BANNER_LINES.flatMap((line) => [line.importLine, line.declarationLine]),
  STANDALONE_DIRNAME_DECLARATION,
  ...DEAD_BANNER_CALL_LINES,
]);

export function stripUnusedNodeEsmCompatBanner(code: string): string {
  if (
    !code.includes("__eveFileURLToPath") &&
    !code.includes("__eveDirname") &&
    !code.includes("__eveCreateRequire")
  ) {
    return code;
  }

  const lines = code.split("\n");
  const body = lines.filter((line) => !BANNER_LINE_SET.has(line.trim())).join("\n");
  const usesRequire = /\brequire\b/.test(body);
  const usesDirname = /\b__dirname\b/.test(body);
  const usesFilename =
    /\b__filename\b/.test(body) ||
    (usesDirname && lines.some((line) => line.trim() === DIRNAME_BANNER_LINE.declarationLine));
  const usesFileURLToPath =
    usesFilename ||
    (usesDirname && lines.some((line) => line.trim() === STANDALONE_DIRNAME_DECLARATION));

  const kept = lines.filter((rawLine) => {
    const line = rawLine.trim();
    if (DEAD_BANNER_CALL_LINES.has(line)) return false;
    if (line === FILENAME_BANNER_LINE.importLine) return usesFileURLToPath;
    if (line === FILENAME_BANNER_LINE.declarationLine) return usesFilename;
    if (line === DIRNAME_BANNER_LINE.importLine) return usesDirname;
    if (line === DIRNAME_BANNER_LINE.declarationLine || line === STANDALONE_DIRNAME_DECLARATION) {
      return usesDirname;
    }
    if (line === REQUIRE_BANNER_LINE.importLine || line === REQUIRE_BANNER_LINE.declarationLine) {
      return usesRequire;
    }
    return true;
  });

  return kept.length === lines.length ? code : kept.join("\n");
}

export function buildNodeEsmCompatBanner(program: ParsedProgram): string {
  const imports: string[] = [];
  const declarations: string[] = [];
  const topLevelBindings = collectTopLevelVariableBindings(program);
  const chunkProvidesFilename = topLevelBindings.has(FILENAME_BANNER_LINE.bindingName);
  const chunkProvidesDirname = topLevelBindings.has(DIRNAME_BANNER_LINE.bindingName);

  for (const line of BANNER_LINES) {
    if (topLevelBindings.has(line.bindingName)) {
      continue;
    }

    imports.push(line.importLine);
    declarations.push(
      line === DIRNAME_BANNER_LINE && chunkProvidesFilename
        ? "const __dirname = __eveDirname(__eveFileURLToPath(import.meta.url));"
        : line.declarationLine,
    );
  }

  if (chunkProvidesFilename && !chunkProvidesDirname) {
    imports.unshift(FILENAME_BANNER_LINE.importLine);
  }

  if (declarations.length === 0) {
    return "";
  }

  return [...imports, ...declarations].join("\n");
}

function collectTopLevelVariableBindings(program: ParsedProgram): ReadonlySet<string> {
  const bindings = new Set<string>();

  for (const statement of program.body) {
    if (statement.type !== "VariableDeclaration") {
      continue;
    }

    for (const declaration of statement.declarations ?? []) {
      if (declaration.id.type === "Identifier" && declaration.id.name !== undefined) {
        bindings.add(declaration.id.name);
      }
    }
  }

  return bindings;
}

interface BannerPluginContext {
  parse(code: string): ParsedProgram;
}

interface BannerPlugin {
  readonly name: string;
  renderChunk(
    this: BannerPluginContext,
    code: string,
    chunk?: { readonly fileName?: string },
  ): { code: string; map: SourceMap } | null;
}

interface SourceMap {
  readonly version: 3;
  readonly sources: readonly string[];
  readonly sourcesContent: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
}

export function createNodeEsmCompatBannerPlugin(): BannerPlugin {
  return {
    name: "eve-node-esm-compat-banner",
    renderChunk(code, chunk) {
      const program = mayDeclareCompatibilityBinding(code) ? this.parse(code) : { body: [] };
      const banner = buildNodeEsmCompatBanner(program);

      if (banner === "") {
        return null;
      }

      return {
        code: `${banner}\n${code}`,
        map: createPrependedLineSourceMap({
          insertedLineCount: banner.split("\n").length,
          source: chunk?.fileName ?? "eve-node-esm-compat-banner-input",
          sourceContent: code,
        }),
      };
    },
  };
}

const DECLARATION_TRIVIA = String.raw`(?:\s|/\*(?:[^*]|\*(?!/))*\*/|//[^\r\n\u2028\u2029]*[\r\n\u2028\u2029])*`;
const DECLARATION_START = String.raw`(?:(?<![\w$"'\x60])(?:var|let|const|using)\b|,)${DECLARATION_TRIVIA}`;
const BINDING_END = String.raw`(?![\w$])`;
const COMPATIBILITY_BINDING_DECLARATION = new RegExp(
  String.raw`${DECLARATION_START}(?:__filename|__dirname|require)${BINDING_END}`,
);
const IDENTIFIER_ESCAPE = String.raw`\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\})`;
const ESCAPED_IDENTIFIER_DECLARATION = new RegExp(
  String.raw`${DECLARATION_START}([\w$]*(?:${IDENTIFIER_ESCAPE}[\w$]*)+)`,
  "g",
);
const IDENTIFIER_ESCAPE_PATTERN = new RegExp(IDENTIFIER_ESCAPE, "g");

function mayDeclareCompatibilityBinding(code: string): boolean {
  return COMPATIBILITY_BINDING_DECLARATION.test(code) || declaresEscapedCompatibilityBinding(code);
}

function declaresEscapedCompatibilityBinding(code: string): boolean {
  if (!code.includes("\\u")) return false;
  for (const match of code.matchAll(ESCAPED_IDENTIFIER_DECLARATION)) {
    const name = match[1]!.replace(IDENTIFIER_ESCAPE_PATTERN, (escape) => {
      const codePoint = Number.parseInt(escape.slice(2).replace(/[{}]/g, ""), 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "\uFFFD";
    });
    if (BANNER_LINES.some((line) => line.bindingName === name)) {
      return true;
    }
  }
  return false;
}

function createPrependedLineSourceMap({
  insertedLineCount,
  source,
  sourceContent,
}: {
  insertedLineCount: number;
  source: string;
  sourceContent: string;
}): SourceMap {
  const originalLineCount = sourceContent.split("\n").length;

  return {
    version: 3,
    sources: [source],
    sourcesContent: [sourceContent],
    names: [],
    mappings: `${";".repeat(insertedLineCount)}AAAA${";AACA".repeat(originalLineCount - 1)}`,
  };
}
