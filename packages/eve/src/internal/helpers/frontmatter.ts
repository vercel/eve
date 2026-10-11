import { load } from "#compiled/js-yaml/index.js";

/** A document split into its YAML frontmatter and body. */
export interface FrontmatterDocument {
  /** Parsed frontmatter. An empty block parses to `{}`. */
  readonly data: unknown;
  /** Body after the closing delimiter line. */
  readonly content: string;
}

const OPENING_FENCE = /^\uFEFF?---(?!-)([^\r\n]*)(?:\r?\n|$)/;
const CLOSING_FENCE = /^---[ \t]*(?:\r?\n|$)/m;

/** Reports whether a document opens with a `---` frontmatter delimiter. */
export function hasFrontmatter(source: string): boolean {
  return OPENING_FENCE.test(source);
}

/**
 * Splits a document into YAML frontmatter and body. Returns `undefined` when
 * the document has no complete `---` block.
 *
 * Frontmatter is always data: js-yaml's default schema has no code-evaluating
 * types, and a fence that names any language other than YAML, such as `---js`,
 * throws instead of being interpreted.
 */
export function parseFrontmatter(source: string): FrontmatterDocument | undefined {
  const opening = OPENING_FENCE.exec(source);
  if (opening === null) return undefined;

  const language = opening[1]!.trim();
  if (language !== "" && language.toLowerCase() !== "yaml") {
    throw new Error(`Frontmatter language "${language}" is not supported. Use YAML frontmatter.`);
  }

  const rest = source.slice(opening[0].length);
  const closing = CLOSING_FENCE.exec(rest);
  if (closing === null) return undefined;

  const yaml = rest.slice(0, closing.index);
  return {
    data: (yaml.trim() === "" ? undefined : load(yaml)) ?? {},
    content: rest.slice(closing.index + closing[0].length),
  };
}

/**
 * Parses a YAML file. A file that opens and closes a `---` block parses only
 * that block, so frontmatter-style YAML files keep working. An empty file
 * parses to `{}`.
 */
export function parseYaml(source: string): unknown {
  const frontmatter = parseFrontmatter(source);
  return frontmatter === undefined ? (load(source) ?? {}) : frontmatter.data;
}
