/* Bounded RichText document validation and same-space reference extraction. */
import {
  BLOCKS,
  INLINES,
  MARKS,
  TOP_LEVEL_BLOCKS,
  validateRichTextDocument,
} from "@contentful/rich-text-types";
import type { Document } from "@contentful/rich-text-types";

import type { JsonObject, JsonValue } from "../json";
import { isObject, isString } from "../values";
import { isLink } from "./content";
import { CONTENTFUL_ID, RICH_TEXT_REFERENCE_NODES } from "./model";
import type { ContentTypeField, Link } from "./types";

// Match Contentful's editor: paragraph/text and structural children are implicit.
const validatableNodes = new Set<string>([
  ...TOP_LEVEL_BLOCKS.filter((kind) => kind !== BLOCKS.PARAGRAPH),
  ...Object.values(INLINES),
]);
const marks = new Set<string>(Object.values(MARKS));
const resources = new Set([
  "embedded-resource-block",
  "embedded-resource-inline",
  "resource-hyperlink",
]);
type RichTextReferenceNode = (typeof RICH_TEXT_REFERENCE_NODES)[number][0];

const object = (value: JsonValue): value is JsonObject =>
  value !== null && isObject(value) && !Array.isArray(value);

/* Node budget for a RichText value supplied whole in one write. */
const MAX_WRITTEN_NODES = 1000;

/**
 * Node budget for a document produced by a RichText patch.
 *
 * @remarks Existing page bodies can exceed the whole-value budget. Each patch's
 * inserted nodes still count against MAX_WRITTEN_NODES.
 */
export const MAX_PATCHED_NODES = 20_000;

/* Bound recursion before invoking Contentful's recursive validator. */
const documentNodes = (
  value: JsonValue,
  maxNodes = MAX_WRITTEN_NODES
): JsonObject[] => {
  const nodes: JsonObject[] = [];
  const pending = [{ depth: 0, value }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!(current && object(current.value))) {
      throw new Error("RichText nodes must be objects.");
    }
    if (current.depth > 20 || nodes.length + pending.length >= maxNodes) {
      throw new Error(
        `RichText exceeds 20 levels or ${maxNodes.toLocaleString("en-US")} nodes.`
      );
    }
    nodes.push(current.value);
    if (Array.isArray(current.value.content)) {
      for (const child of current.value.content) {
        pending.push({ depth: current.depth + 1, value: child });
      }
    }
  }
  return nodes;
};

/**
 * Extracts supported entry and asset references from a bounded rich-text document.
 *
 * @param value - Candidate rich-text document; non-document values produce no links.
 * @param maxNodes - Maximum nodes allowed while traversing the document.
 * @returns Supported links paired with the rich-text node type that carries each reference.
 * @throws {@link Error} When traversal exceeds the node or nesting limits.
 */
export const richTextLinks = (
  value: JsonValue,
  maxNodes = MAX_WRITTEN_NODES
): { link: Link; nodeType: RichTextReferenceNode }[] => {
  if (!object(value) || value.nodeType !== "document") {
    return [];
  }
  return documentNodes(value, maxNodes).flatMap((node) => {
    const kind = RICH_TEXT_REFERENCE_NODES.find(
      ([nodeType]) => node.nodeType === nodeType
    );
    const target = object(node.data) ? node.data.target : undefined;
    return kind && isLink(target) ? [{ link: target, nodeType: kind[0] }] : [];
  });
};

const validateMarks = (node: JsonObject, field: ContentTypeField) => {
  if (node.nodeType !== "text" || !Array.isArray(node.marks)) {
    return;
  }
  for (const mark of node.marks) {
    if (!object(mark) || !isString(mark.type) || !marks.has(mark.type)) {
      throw new Error("Unsupported RichText mark.");
    }
    if (
      field.validations?.some(
        (rule) =>
          rule.enabledMarks !== undefined &&
          // SAFETY: The preceding isString guard checked this mark; the synchronous callback does not mutate it.
          !rule.enabledMarks.includes(mark.type as string)
      )
    ) {
      throw new Error(`RichText mark ${mark.type} is disabled for this field.`);
    }
  }
};

const validateNodeRules = (node: JsonObject, field: ContentTypeField) => {
  const nodeType = String(node.nodeType);
  if (resources.has(nodeType)) {
    throw new Error(
      "Cross-space RichText resource links are not supported for writes."
    );
  }
  if (
    validatableNodes.has(nodeType) &&
    field.validations?.some(
      (rule) =>
        rule.enabledNodeTypes !== undefined &&
        !rule.enabledNodeTypes.includes(nodeType)
    )
  ) {
    throw new Error(`RichText node ${nodeType} is disabled for this field.`);
  }
  validateMarks(node, field);
};

const validateReferenceCounts = (
  nodes: JsonObject[],
  field: ContentTypeField
) => {
  for (const [nodeType] of RICH_TEXT_REFERENCE_NODES) {
    const count = nodes.filter((node) => node.nodeType === nodeType).length;
    const rules =
      field.validations?.flatMap((rule) => rule.nodes?.[nodeType] ?? []) ?? [];
    if (
      rules.some(
        ({ size }) =>
          size &&
          ((size.min !== undefined && count < size.min) ||
            (size.max !== undefined && count > size.max))
      )
    ) {
      throw new Error(
        `RichText node ${nodeType} exceeds its allowed reference count.`
      );
    }
  }
};

/**
 * Validates rich-text structure, marks, field constraints, and reference IDs before a write.
 *
 * @param field - Live content-model field definition, including required and node-specific rules.
 * @param value - Proposed complete rich-text document.
 * @param maxNodes - Traversal limit, raised for validated patches when appropriate.
 * @throws {@link Error} When the document is malformed, exceeds bounds, or violates model constraints.
 */
export const validateRichTextValue = (
  field: ContentTypeField & { required?: boolean },
  value: JsonValue,
  maxNodes = MAX_WRITTEN_NODES
) => {
  const nodes = documentNodes(value, maxNodes);
  // SAFETY: Contentful’s validator accepts untrusted documents and reports their structural errors.
  const errors = validateRichTextDocument(value as Document & JsonObject);
  if (errors.length > 0) {
    throw new Error(
      `Invalid RichText document: ${errors
        .slice(0, 5)
        .map(
          (error) =>
            `${error.path?.join(".") ?? "document"}: ${error.details ?? error.name}`
        )
        .join("; ")}`
    );
  }
  for (const node of nodes) {
    validateNodeRules(node, field);
  }
  validateReferenceCounts(nodes, field);
  for (const { link } of richTextLinks(value, maxNodes)) {
    if (!CONTENTFUL_ID.test(link.sys.id) || link.sys.id.length > 128) {
      throw new Error("Invalid RichText reference ID.");
    }
  }
  if (
    field.required &&
    !nodes.some(
      (node) =>
        (node.nodeType === "text" &&
          isString(node.value) &&
          node.value.trim().length > 0) ||
        RICH_TEXT_REFERENCE_NODES.some(([kind]) => kind === node.nodeType)
    )
  ) {
    throw new Error("Required RichText field cannot be empty.");
  }
};
