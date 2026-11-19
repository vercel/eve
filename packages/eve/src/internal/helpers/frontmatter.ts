import { CORE_SCHEMA, loadAll, mergeTag } from "#compiled/js-yaml/index.js";

const schema = CORE_SCHEMA.withTags(mergeTag);

function loadDocument(source: string): unknown {
  const documents = loadAll(source, { schema });
  if (documents.length > 1) {
    throw new Error("Expected a single YAML document, but found more than one.");
  }
  return documents[0] ?? {};
}

export interface FrontmatterDocument {
  readonly data: unknown;
  readonly content: string;
}

const OPENING_FENCE = /^\uFEFF?---(?!-)([^\r\n]*)(?:\r?\n|$)/;
const CLOSING_FENCE = /^---[ \t]*(?:\r?\n|$)/m;

export function hasFrontmatter(source: string): boolean {
  return OPENING_FENCE.test(source);
}

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
    data: loadDocument(yaml),
    content: rest.slice(closing.index + closing[0].length),
  };
}

export function parseYaml(source: string): unknown {
  const frontmatter = parseFrontmatter(source);
  return frontmatter === undefined ? loadDocument(source) : frontmatter.data;
}
