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

/**
 * Builds the ESM CommonJS-compatibility banner appropriate for a parsed
 * bundle chunk. Identifiers the chunk already binds in a top-level variable
 * declaration are skipped so the prepended banner never re-declares them.
 *
 * Returns an empty string when the chunk already provides every binding.
 */
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
    // The chunk's binding is initialized after this prepended banner.
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

/**
 * Creates a bundler plugin that prepends the Node ESM compatibility
 * banner to each output chunk, skipping any banner line whose binding
 * the chunk already provides. Compatible with both Rollup and Rolldown.
 */
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

// A block comment body must not be able to span `*/`: a lazy `[\s\S]*?`
// lets a failed match re-end the comment at every later `*/`, which
// backtracks catastrophically on large JSDoc-heavy chunks.
const DECLARATION_TRIVIA = String.raw`(?:\s|/\*(?:[^*]|\*(?!/))*\*/|//[^\r\n\u2028\u2029]*[\r\n\u2028\u2029])*`;
// A keyword directly after a quote can only be string content, such as these
// banner templates in a bundled copy of this module; it must not force a parse.
const DECLARATION_START = String.raw`(?:(?<![\w$"'\x60])(?:var|let|const|using)\b|,)${DECLARATION_TRIVIA}`;
// `\b` would accept bundler-deconflicted names such as `__filename$1`, which
// would force a needless parse of a possibly large bundle.
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
  // This is only a negative filter: comments/strings can cause extra parsing,
  // never a missed declaration. Nearly every large bundle contains `\u` in
  // strings or regexes, so escaped names are decoded rather than treated as a
  // reason to parse the whole chunk.
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
