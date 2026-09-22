/**
 * Options for {@link buildNodeEsmCompatBanner} and
 * {@link createNodeEsmCompatBannerPlugin}.
 *
 * Bundle output that re-declares one of the CJS path globals at the top
 * level would otherwise collide with the banner, producing
 * `SyntaxError: Identifier '__dirname' has already been declared` at load
 * time. The banner builder omits any line whose binding the chunk already
 * provides.
 */
interface NodeEsmCompatBannerOptions {
  /** Whether to expose a CommonJS `require` shim alongside the path globals. */
  readonly includeRequire?: boolean;
}

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
];

const FILENAME_BANNER_LINE = BANNER_LINES[0]!;
const DIRNAME_BANNER_LINE = BANNER_LINES[1]!;

const REQUIRE_LINE: BannerLine = {
  importLine: 'import { createRequire as __eveCreateRequire } from "node:module";',
  declarationLine: "const require = __eveCreateRequire(import.meta.url);",
  bindingName: "require",
};

/**
 * Builds the ESM CommonJS-compatibility banner appropriate for a parsed
 * bundle chunk. Identifiers the chunk already binds in a top-level variable
 * declaration are skipped so the prepended banner never re-declares them.
 *
 * Returns an empty string when the chunk already provides every binding.
 */
export function buildNodeEsmCompatBanner(
  program: ParsedProgram,
  options: NodeEsmCompatBannerOptions = {},
): string {
  const lines: BannerLine[] = [...BANNER_LINES];

  if (options.includeRequire === true) {
    lines.push(REQUIRE_LINE);
  }

  const imports: string[] = [];
  const declarations: string[] = [];
  const topLevelBindings = collectTopLevelVariableBindings(program);
  const chunkProvidesFilename = topLevelBindings.has(FILENAME_BANNER_LINE.bindingName);
  const chunkProvidesDirname = topLevelBindings.has(DIRNAME_BANNER_LINE.bindingName);

  for (const line of lines) {
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
export function createNodeEsmCompatBannerPlugin(
  options: NodeEsmCompatBannerOptions = {},
): BannerPlugin {
  return {
    name: "eve-node-esm-compat-banner",
    renderChunk(code, chunk) {
      const program = mayDeclareCompatibilityBinding(code, options)
        ? this.parse(code)
        : { body: [] };
      const banner = buildNodeEsmCompatBanner(program, options);

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

const DECLARATION_TRIVIA = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n\u2028\u2029]*[\r\n\u2028\u2029])*`;
const PATH_BINDING_DECLARATION = new RegExp(
  String.raw`(?:\b(?:var|let|const|using)\b|,)${DECLARATION_TRIVIA}(?:__filename|__dirname)\b`,
);
const REQUIRE_BINDING_DECLARATION = new RegExp(
  String.raw`(?:\b(?:var|let|const|using)\b|,)${DECLARATION_TRIVIA}require\b`,
);

function mayDeclareCompatibilityBinding(
  code: string,
  options: NodeEsmCompatBannerOptions,
): boolean {
  // This is only a negative filter: comments/strings can cause extra parsing,
  // never a missed declaration. Escaped identifiers always use the parser.
  return (
    code.includes("\\u") ||
    PATH_BINDING_DECLARATION.test(code) ||
    (options.includeRequire === true && REQUIRE_BINDING_DECLARATION.test(code))
  );
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
