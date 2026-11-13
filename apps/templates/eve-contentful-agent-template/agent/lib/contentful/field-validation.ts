import { z } from "zod";

import type { JsonValue } from "../json";
/**
 * Field and reference validation shared by updates and supporting-entry creation.
 *
 * @packageDocumentation
 */
import { isString, isNumber } from "../values";
import { callApi } from "./api";
import { isLink, isLive } from "./content";
import { updateFieldIdSchema } from "./input-schemas";
import type { ContentfulEntryUpdate } from "./input-schemas";
import {
  MAX_PATCHED_NODES,
  richTextLinks,
  validateRichTextValue,
} from "./rich-text";
import { applyRichTextPatch, richTextPatchInsertions } from "./rich-text-patch";
import { assertRichTextWritable } from "./rich-text-policy";
import type { FieldWriteContext } from "./rich-text-policy";
import type {
  Collection,
  ContentTypeField,
  Link,
  RawContentType,
  RawEntry,
} from "./types";

type UpdateField = RawContentType["fields"][number];

/* Validate writable field shapes locally; Contentful remains authoritative. */
const updateValueSchema = (
  field: ContentTypeField & { items?: ContentTypeField }
): z.ZodType => {
  switch (field.type) {
    case "Symbol": {
      return z.string().max(256);
    }
    case "Text": {
      return z.string();
    }
    case "Integer": {
      return z.number().int();
    }
    case "Number": {
      return z.number();
    }
    case "Boolean": {
      return z.boolean();
    }
    case "Date": {
      return z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
    }
    case "Link": {
      if (field.linkType === "Entry" || field.linkType === "Asset") {
        return z
          .object({
            sys: z
              .object({
                id: updateFieldIdSchema,
                linkType: z.literal(field.linkType),
                type: z.literal("Link"),
              })
              .strict(),
          })
          .strict();
      }
      break;
    }
    case "Array": {
      if (field.items) {
        return z.array(updateValueSchema(field.items)).max(100);
      }
      break;
    }
    default: {
      break;
    }
  }
  throw new Error(`Field type ${field.type} is not supported for writes.`);
};

const validateUpdateConstraints = (
  field: ContentTypeField,
  value: JsonValue
) => {
  for (const validation of field.validations ?? []) {
    if (validation.in && !validation.in.some((allowed) => allowed === value)) {
      throw new Error("Value is not in the field's allowed values.");
    }
    const size =
      isString(value) || Array.isArray(value) ? value.length : undefined;
    for (const [actual, bounds] of [
      [size, validation.size],
      [isNumber(value) ? value : undefined, validation.range],
    ] as const) {
      if (
        actual !== undefined &&
        bounds &&
        ((bounds.min !== undefined && actual < bounds.min) ||
          (bounds.max !== undefined && actual > bounds.max))
      ) {
        throw new Error("Value is outside the field's allowed size or range.");
      }
    }
  }
};

type UpdateChange = ContentfulEntryUpdate["changes"][number];

/**
 * Turn a patch into the complete value it writes; set and unset pass through.
 *
 * @param field - Field definition from the entry's current content type.
 * @param change - Parsed field operation.
 * @param current - The field's current configured-locale value from the same entry read.
 * @returns The change with its value replaced by the patched document for patches.
 * @throws {@link Error} If a patch targets a non-RichText field or cannot be applied.
 */
export const resolveUpdateChange = (
  field: UpdateField,
  change: UpdateChange,
  current: JsonValue
): UpdateChange => {
  if (change.operation !== "patch") {
    return change;
  }
  if (field.type !== "RichText") {
    throw new Error(
      `Field ${field.id}: patch only applies to RichText fields.`
    );
  }
  try {
    return { ...change, value: applyRichTextPatch(current, change.value) };
  } catch (error) {
    throw new Error(
      `Field ${field.id}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

/**
 * Narrows a patch to its introduced nodes before validating new references.
 *
 * @param change - Original unresolved field operation; set and unset operations pass through.
 * @returns A set-shaped reference projection for patches, otherwise the unchanged operation.
 */
export const referenceChange = (change: UpdateChange): UpdateChange =>
  change.operation === "patch"
    ? {
        ...change,
        operation: "set",
        value: richTextPatchInsertions(change.value),
      }
    : change;

const validateRichTextChange = (field: UpdateField, change: UpdateChange) => {
  if (change.operation === "unset") {
    if (field.required) {
      throw new Error(`Required field ${field.id} cannot be unset.`);
    }
    return;
  }
  try {
    validateRichTextValue(
      field,
      change.value,
      change.operation === "patch" ? MAX_PATCHED_NODES : undefined
    );
  } catch (error) {
    throw new Error(
      `Invalid value for ${field.id}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

/**
 * Validate a set/unset operation, or a resolved patch, against a field's writable field definition and constraints.
 *
 * @param field - Field definition from the entry's current content type.
 * @param change - Parsed field operation; set values replace the whole configured-locale value, and
 * patches carry the complete document from resolveUpdateChange.
 * @param context - Actual entry space and content type used to enforce the RichText body-field denylist.
 * @throws {@link Error} If the field is disabled/omitted/unsupported or the value violates requiredness or constraints.
 * @remarks Performs no requests. Linked-target existence and type restrictions are checked separately.
 */
export const validateUpdateChange = (
  field: UpdateField,
  change: UpdateChange,
  context: FieldWriteContext
): void => {
  if (field.disabled || field.omitted) {
    throw new Error(
      `Field ${field.id} is disabled or omitted and cannot be written.`
    );
  }
  assertRichTextWritable(context, field, change.operation);
  if (field.type === "RichText") {
    validateRichTextChange(field, change);
    return;
  }
  const schema = updateValueSchema(field);
  if (change.operation === "unset") {
    if (field.required) {
      throw new Error(`Required field ${field.id} cannot be unset.`);
    }
    return;
  }
  const result = schema.safeParse(change.value);
  if (!result.success) {
    throw new Error(`Invalid value for ${field.id}: ${result.error.message}`);
  }
  if (
    field.required &&
    (change.value === "" ||
      (Array.isArray(change.value) && change.value.length === 0))
  ) {
    throw new Error(`Required field ${field.id} cannot be empty.`);
  }
  try {
    validateUpdateConstraints(field, change.value);
    if (field.items && Array.isArray(change.value)) {
      for (const item of change.value) {
        validateUpdateConstraints(field.items, item);
      }
    }
  } catch (error) {
    throw new Error(
      `Invalid value for ${field.id}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

/**
 * Extracts direct, array, and nested rich-text references from a field change.
 *
 * @param change - Parsed field operation whose value should be inspected.
 * @returns Supported Contentful links without fetching their targets.
 */
export const updateLinks = (
  change: ContentfulEntryUpdate["changes"][number]
): Link[] => {
  const values: JsonValue[] = Array.isArray(change.value)
    ? change.value
    : [change.value];
  return [
    ...values.filter(isLink),
    ...richTextLinks(change.value).map(({ link }) => link),
  ];
};

const updateReferenceConstraints = (
  field: UpdateField | undefined,
  change: ContentfulEntryUpdate["changes"][number]
) => {
  const fieldDefinition = field?.type === "Array" ? field.items : field;
  if (fieldDefinition?.type === "RichText") {
    return richTextLinks(change.value).map(({ link, nodeType }) => ({
      link,
      validations: fieldDefinition.validations?.flatMap(
        (rule) => rule.nodes?.[nodeType] ?? []
      ),
    }));
  }
  return updateLinks(change).map((link) => ({
    link,
    validations: fieldDefinition?.validations,
  }));
};

const loadUpdateTargets = async (
  base: string,
  links: Link[],
  signal?: AbortSignal
) => {
  const targets = new Map<string, RawEntry>();
  for await (const linkType of ["Entry", "Asset"]) {
    const ids = links
      .filter((link) => link.sys.linkType === linkType)
      .map((link) => link.sys.id);
    if (ids.length === 0) {
      continue;
    }

    const collection = await callApi<Collection<RawEntry>>(
      `${base}/${linkType === "Entry" ? "entries" : "assets"}`,
      { limit: "100", select: "sys", "sys.id[in]": ids.join(",") },
      signal
    );
    for (const target of collection.items) {
      targets.set(`${linkType}:${target.sys.id}`, target);
    }
  }
  return targets;
};

/**
 * Resolve distinct references in batches and enforce target restrictions.
 *
 * @param base - CMA space/environment path for the entry being written.
 * @param model - Its content type, including link and array-item restrictions.
 * @param changes - Parsed operations whose scalar, array, and RichText references are inspected.
 * @param signal - Optional cancellation passed to batched target reads.
 * @param requirePublished - Creation requires live targets; false allows drafts during updates.
 * @param pendingAssets - Asset IDs reserved by this operation, validated separately before writes.
 * @throws {@link Error} If there are too many references, a target is missing/disallowed/not live when required, or a read fails.
 * @remarks Deduplicates by link kind and ID, with at most one lookup per kind. It neither
 * fetches target bodies nor publishes pending changes on an existing reference.
 */
export const validateUpdateReferences = async (
  base: string,
  model: RawContentType,
  changes: ContentfulEntryUpdate["changes"],
  signal?: AbortSignal,
  requirePublished = false,
  pendingAssets: ReadonlySet<string> = new Set()
): Promise<void> => {
  const links = new Map(
    changes
      .flatMap(updateLinks)
      .map((link) => [`${link.sys.linkType}:${link.sys.id}`, link])
  );
  if (links.size > 100) {
    throw new Error("Field changes exceed 100 distinct references.");
  }
  const pending = (link: Link) =>
    link.sys.linkType === "Asset" && pendingAssets.has(link.sys.id);
  const targets = await loadUpdateTargets(
    base,
    [...links.values()].filter((link) => !pending(link)),
    signal
  );
  for (const change of changes) {
    const field = model.fields.find(({ id }) => id === change.fieldId);
    for (const { link, validations } of updateReferenceConstraints(
      field,
      change
    )) {
      if (pending(link)) {
        continue;
      }
      const target = targets.get(`${link.sys.linkType}:${link.sys.id}`);
      if (!target) {
        throw new Error(
          `${change.fieldId}: referenced ${link.sys.linkType} ${link.sys.id} was not found.`
        );
      }
      if (requirePublished && !isLive(target.sys)) {
        throw new Error(
          `${change.fieldId}: referenced ${link.sys.linkType} ${link.sys.id} is unpublished or archived. Create and publish children first, or publish the existing reference separately.`
        );
      }
      if (
        link.sys.linkType === "Entry" &&
        validations?.some(
          (validation) =>
            validation.linkContentType &&
            !validation.linkContentType.includes(
              target.sys.contentType?.sys.id ?? ""
            )
        )
      ) {
        throw new Error(
          `${change.fieldId}: reference ${link.sys.id} has a disallowed content type.`
        );
      }
    }
  }
};
