import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "../json";
import { isString, isObject } from "../values";
/**
 * Pure configured-locale content rendering, normalization, publication-status helpers,
 * and reference traversal shared by queries and publication planning.
 *
 * @packageDocumentation
 */
import { contentLocale } from "./locale";
import type {
  EntryStatus,
  Link,
  LinkedItem,
  LocalizedFields,
  RawSys,
} from "./types";

/**
 * Reads one string field in the active operation locale.
 *
 * @param fields - Localized CMA fields, or undefined for an entry without fields.
 * @param key - Field ID to inspect.
 * @returns The localized string, or null when the field is absent or not a string.
 */
export const readString = (
  fields: LocalizedFields | undefined,
  key: string
): string | null => {
  const value = fields?.[key]?.[contentLocale()];
  return isString(value) ? value : null;
};

/**
 * Recognizes Contentful link metadata for downstream reference handling.
 *
 * @param value - Field value to inspect without mutating it.
 * @returns Whether the value contains Link system metadata and a string ID.
 */
export const isLink = (value: JsonValue): value is Link => {
  if (!isObject(value) || value === null) {
    return false;
  }
  if (!("sys" in value)) {
    return false;
  }
  const { sys } = value;
  return (
    isObject(sys) &&
    !Array.isArray(sys) &&
    sys.type === "Link" &&
    isString(sys.id) &&
    isString(sys.linkType)
  );
};

/* A node of a Contentful Rich Text document; only the parts the renderer reads. */
interface RichTextNode extends JsonObject {
  content?: RichTextNode[];
  /* Link target for embedded and hyperlink nodes, or `uri` for external hyperlinks. */
  data?: { target?: Link; uri?: string };
  nodeType: string;
  /* Text content; `text` nodes only. */
  value?: string;
}

/**
 * Recognizes the root shape used to render a Contentful rich-text document.
 *
 * @param value - Field value to inspect before rendering its content array.
 * @returns Whether the value is a document node with an array of child nodes.
 * @remarks This read-side check is not the structural validation required before writes.
 */
// SAFETY: This CMA read-side discriminator checks only the root; writes use validateRichTextValue for complete structural validation.
export const isRichTextDocument = (
  value: JsonValue
): value is RichTextNode & { content: RichTextNode[] } =>
  isObject(value) &&
  value !== null &&
  (value as RichTextNode).nodeType === "document" &&
  Array.isArray((value as RichTextNode).content);

/* Node types that end with a blank line when rendered. */
const BLOCK_NODES = new Set([
  "paragraph",
  "heading-1",
  "heading-2",
  "heading-3",
  "heading-4",
  "heading-5",
  "heading-6",
  "blockquote",
  "hr",
  "table-row",
  "embedded-entry-block",
  "embedded-asset-block",
]);

/* Render a hyperlink node's text with its target appended. */
const renderHyperlink = (node: RichTextNode, text: string): string => {
  if (node.nodeType === "hyperlink") {
    return node.data?.uri ? `${text} (${node.data.uri})` : text;
  }
  const target = node.data?.target?.sys;
  return `${text} [link to ${target?.linkType?.toLowerCase() ?? "item"} ${target?.id ?? "?"}]`;
};

/* Render a container node: headings and block nodes end with a blank line. */
const renderBlock = (nodeType: string, inner: string): string => {
  if (nodeType.startsWith("heading-")) {
    return `\n${inner.trim()}\n\n`;
  }
  return BLOCK_NODES.has(nodeType) ? `${inner.trimEnd()}\n\n` : inner;
};

const embeddedId = (node: RichTextNode) => node.data?.target?.sys.id ?? "?";

/**
 * Convert a Contentful Rich Text document into readable plain text.
 *
 * @remarks
 * Headings and paragraphs are separated by blank lines, list items get a
 * `-` prefix and indent by nesting depth, table cells are joined with `|`,
 * external hyperlinks keep their URL in parentheses, and embedded entries or
 * assets become `[embedded entry <id>]` placeholders. Marks such as bold are
 * dropped.
 *
 * @param doc - The root `document` node of a Rich Text field.
 * @returns Plain text with at most one blank line between blocks.
 */
const richTextToPlainText = (doc: RichTextNode): string => {
  const walk = (node: RichTextNode, depth: number): string => {
    const children = (childDepth = depth) =>
      (node.content ?? []).map((c) => walk(c, childDepth)).join("");
    switch (node.nodeType) {
      case "text": {
        return node.value ?? "";
      }
      case "hr": {
        return "---\n";
      }
      case "list-item": {
        return `${"  ".repeat(Math.max(depth - 1, 0))}- ${children().trim()}\n`;
      }
      case "unordered-list":
      case "ordered-list": {
        return children(depth + 1);
      }
      case "table-cell":
      case "table-header-cell": {
        return `${children().trim()} | `;
      }
      case "embedded-entry-block":
      case "embedded-entry-inline": {
        return `[embedded entry ${embeddedId(node)}]`;
      }
      case "embedded-asset-block": {
        return `[embedded asset ${embeddedId(node)}]`;
      }
      case "entry-hyperlink":
      case "asset-hyperlink":
      case "hyperlink": {
        return renderHyperlink(node, children());
      }
      default: {
        return renderBlock(node.nodeType, children());
      }
    }
  };
  return walk(doc, 0)
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
};

/**
 * Derives an entry's publication state from CMA version counters.
 *
 * @param sys - System metadata from a Contentful entry or asset.
 * @returns Archived, draft, changed, or published status, in that precedence order.
 */
export const entryStatus = (sys: RawSys): EntryStatus => {
  if (sys.archivedVersion !== undefined) {
    return "archived";
  }
  if (sys.publishedVersion === undefined) {
    return "draft";
  }
  if ((sys.version ?? 0) >= sys.publishedVersion + 2) {
    return "changed";
  }
  return "published";
};

/**
 * Collect entry and asset links from nested field values, keyed by resource kind and ID.
 *
 * @param value - Field value, array, or object to traverse, including rich-text data targets.
 * @param out - Mutated lookup; repeated links of the same kind and ID replace earlier occurrences.
 * @remarks Unsupported link kinds are skipped. This lenient collector serves content reads;
 * publication/query coverage uses {@link queryFieldReferences} to surface unsupported links.
 */
export const collectLinks = (
  value: JsonValue,
  out: Map<string, Link>
): void => {
  if (isLink(value)) {
    if (value.sys.linkType === "Entry" || value.sys.linkType === "Asset") {
      out.set(`${value.sys.linkType}:${value.sys.id}`, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLinks(item, out);
    }
  } else if (isObject(value) && value !== null) {
    for (const child of Object.values(value)) {
      collectLinks(child, out);
    }
  }
};

/* Fields tried, in order, when guessing a linked entry's title. */
const TITLE_FIELDS = [
  "title",
  "name",
  "internalName",
  "internalTitle",
  "heading",
  "slug",
];

/**
 * Finds a display title without assuming a particular Contentful content model.
 *
 * @param fields - Localized fields in which common title names are tried before other strings.
 * @returns The first nonempty title candidate in the active locale, or null.
 */
export const guessTitle = (
  fields: LocalizedFields | undefined
): string | null => {
  if (!fields) {
    return null;
  }
  for (const key of TITLE_FIELDS) {
    const value = readString(fields, key);
    if (value) {
      return value;
    }
  }
  for (const key of Object.keys(fields)) {
    const value = readString(fields, key);
    if (value) {
      return value;
    }
  }
  return null;
};

/* Longest a single text field may be before it is cut. */
const MAX_FIELD_CHARS = 20_000;

/* Longest all text fields together may be before the rest is cut. */
const MAX_TOTAL_CHARS = 80_000;

/**
 * Flatten configured-locale fields into bounded values suitable for model consumption.
 *
 * @param rawFields - Localized fields; absent or null configured-locale values are omitted.
 * @param linked - Best-effort resolved link metadata, matched by resource kind and ID.
 * @returns Flattened fields and a flag indicating whether any text was clipped.
 * @remarks Renders rich text, replaces links with metadata or identity placeholders, and
 * keeps empty strings/arrays. Text is limited to 20,000 characters per value and 80,000
 * overall; this is a text budget, not a bound on the entire serialized result.
 */
export const flattenFields = (
  rawFields: LocalizedFields,
  linked: LinkedItem[]
) => {
  const linkedById = new Map(linked.map((l) => [`${l.type}:${l.id}`, l]));
  let budget = MAX_TOTAL_CHARS;
  let truncated = false;
  const clip = (text: string): string => {
    const limit = Math.min(MAX_FIELD_CHARS, budget);
    let out = text;
    if (out.length > limit) {
      const marker = "\n…[truncated]".slice(0, limit);
      out = out.slice(0, limit - marker.length) + marker;
      truncated = true;
    }
    budget -= out.length;
    return out;
  };
  const flatten = (value: JsonValue): JsonValue => {
    if (isString(value)) {
      return clip(value);
    }
    if (isRichTextDocument(value)) {
      return clip(richTextToPlainText(value));
    }
    if (isLink(value)) {
      return flatten(
        linkedById.get(`${value.sys.linkType}:${value.sys.id}`) ?? {
          id: value.sys.id,
          title: null,
          type: value.sys.linkType,
        }
      );
    }
    if (Array.isArray(value)) {
      return value.map(flatten);
    }
    if (isObject(value) && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, flatten(child)])
      );
    }
    return value;
  };

  const fields: JsonObject = {};
  for (const [key, perLocale] of Object.entries(rawFields)) {
    const value = perLocale[contentLocale()];
    if (value !== undefined && value !== null) {
      fields[key] = flatten(value);
    }
  }
  return { fields, truncated };
};

/**
 * Checks whether a resource has any published version and is not archived.
 *
 * @param sys - CMA metadata of the entry or asset.
 * @returns True for published resources, including those with pending unpublished changes.
 */
export const isLive = (sys: RawSys): boolean =>
  sys.publishedVersion !== undefined && sys.archivedVersion === undefined;

/* Text leaves retain JSON-pointer locations, including fields in nested JSON. */
interface ContentSection {
  /* Top-level RichText block identity, present only when reading by block. */
  block?: { hash: string; index: number; node: JsonValue; nodeType: string };
  field: string;
  text: string;
}

/**
 * Computes the short content hash used to bind patches to a previously read block.
 *
 * @param node - Raw top-level rich-text block exactly as returned by Contentful.
 * @returns The first twelve hexadecimal characters of the block's JSON SHA-256 digest.
 */
export const richTextBlockHash = (node: JsonValue): string =>
  createHash("sha256").update(JSON.stringify(node)).digest("hex").slice(0, 12);

/**
 * Renders a rich-text document as a whole or as individually addressable top-level blocks.
 *
 * @param document - Rich-text document to render into readable sections.
 * @param field - Field path retained on every generated section.
 * @param byBlock - Includes block indexes, hashes, and empty-block labels when true.
 * @returns Rendered sections, omitting empty whole-document text.
 */
const richTextSections = (
  document: RichTextNode,
  field: string,
  byBlock = false
): ContentSection[] => {
  if (!byBlock) {
    const text = richTextToPlainText(document);
    return text.length ? [{ field, text }] : [];
  }
  return (document.content ?? []).map((node, index) => ({
    block: {
      hash: richTextBlockHash(node),
      index,
      node,
      nodeType: node.nodeType,
    },
    field,
    text:
      richTextToPlainText({ content: [node], nodeType: "document" }) ||
      `[empty ${node.nodeType}]`,
  }));
};

const pointer = (key: string) =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Collects configured-locale text while retaining paths and optional rich-text block identities.
 *
 * @param fields - Localized entry fields, including nested JSON and rich text.
 * @param options - Enables per-block sections with indexes and hashes for targeted patches.
 * @returns Nonempty text sections identified by JSON-pointer-compatible field paths.
 */
export const contentSections = (
  fields: LocalizedFields,
  options: { richTextBlocks?: boolean } = {}
): ContentSection[] => {
  const sections: ContentSection[] = [];

  const visit = (value: JsonValue, field: string): void => {
    if (isString(value)) {
      if (value.length) {
        sections.push({ field, text: value });
      }
    } else if (isRichTextDocument(value)) {
      sections.push(...richTextSections(value, field, options.richTextBlocks));
    } else if (isLink(value)) {
      // References are returned separately, not rendered as their metadata.
    } else if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        visit(child, `${field}/${index}`);
      }
    } else if (value && isObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, `${field}/${pointer(key)}`);
      }
    }
  };
  for (const [key, locales] of Object.entries(fields)) {
    visit(locales[contentLocale()], `/${pointer(key)}`);
  }
  return sections;
};

/* One reference occurrence, retaining its escaped field path and rich-text relationship. */
/**
 * One reference occurrence with its escaped field path and rich-text relationship.
 */
export interface QueryReference {
  field: string;
  id: string;
  linkType: "Entry" | "Asset";
  nodeType: string | null;
  path: string;
  relationship: "embed" | "hyperlink" | "reference";
}

const queryReferenceRelationship = (
  nodeType: string | null
): QueryReference["relationship"] => {
  switch (nodeType) {
    case "embedded-entry-block":
    case "embedded-entry-inline":
    case "embedded-asset-block": {
      return "embed";
    }
    case "entry-hyperlink":
    case "asset-hyperlink": {
      return "hyperlink";
    }
    default: {
      return "reference";
    }
  }
};

interface QueryReferenceLocation {
  nodeType: string | null;
  path: string;
  richText: boolean;
  value: JsonValue;
}

const queryReferenceChildren = (
  current: QueryReferenceLocation,
  object: JsonObject
): QueryReferenceLocation[] => {
  const richText = current.richText || isRichTextDocument(object);
  const { nodeType: richNodeType } = object;
  return Object.entries(object)
    .toReversed()
    .map(([childKey, value]) => {
      // Carry a rich-text node's type only through its data.target path.
      let nodeType = childKey === "target" ? current.nodeType : null;
      if (richText && childKey === "data" && isString(richNodeType)) {
        nodeType = richNodeType;
      }
      return {
        nodeType,
        path: `${current.path}/${childKey.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        richText,
        value,
      };
    });
};

/**
 * Walk references iteratively without exhausting the call stack on deep JSON.
 *
 * @param value - An unlocalized field value or object containing fields to inspect.
 * @param field - Root field/path label carried into each result and extended with escaped segments.
 * @returns A lazy sequence of reference occurrences; null explicitly marks an unsupported link.
 * @remarks Keeps duplicate occurrences and their paths. Callers own deduplication and budgets.
 * Rich-text embeds and hyperlinks retain their relationship; external/resource links cannot
 * be silently treated as complete same-space traversal.
 */
export const queryFieldReferences = function* queryFieldReferences(
  value: JsonValue,
  field: string
): Generator<QueryReference | null> {
  const stack: QueryReferenceLocation[] = [
    { nodeType: null, path: field, richText: false, value },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !isObject(current.value) || current.value === null) {
      continue;
    }
    // SAFETY: JsonValue was narrowed to a non-null object above; the traversal handles arrays through their enumerable children.
    const object = current.value as JsonObject;
    if (isLink(object)) {
      yield object.sys.id &&
      (object.sys.linkType === "Entry" || object.sys.linkType === "Asset")
        ? {
            field,
            id: object.sys.id,
            linkType: object.sys.linkType,
            nodeType: current.nodeType,
            path: current.path,
            relationship: queryReferenceRelationship(current.nodeType),
          }
        : null;
      continue;
    }
    // SAFETY: Only the optional type discriminator is compared; no nested structure is assumed or dereferenced.
    const sys = object.sys as { type?: string } | undefined;
    if (sys?.type === "ResourceLink" || sys?.type === "Link") {
      yield null;
      continue;
    }
    for (const child of queryReferenceChildren(current, object)) {
      stack.push(child);
    }
  }
};
