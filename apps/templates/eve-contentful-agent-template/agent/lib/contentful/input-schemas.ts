import { z } from "zod";
/**
 * Model-facing Contentful inputs and their inferred TypeScript types.
 * Nullable fields and descriptions are part of the tool contract.
 *
 * @packageDocumentation
 */

import { isAssetFilePath } from "./assets/files";
import { configuredSpaces } from "./config";
import { CONTENTFUL_ID } from "./model";

const querySpaceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(CONTENTFUL_ID)
  .refine(
    (space) => Object.hasOwn(configuredSpaces(), space),
    "Space is not configured."
  )
  .describe(
    "Configured Contentful space ID or alias. Uses CONTENTFUL_ENVIRONMENT_ID."
  );

const queryLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(50)
  .nullable()
  .describe("Maximum results per page, from 1 to 50. Null means 25.");

const querySkipSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 50)
  .nullable()
  .describe(
    "Result offset for this page. Null means zero. Use nextSkip to continue."
  );

/* Tool contract for one content type or a paginated catalog; nullable controls select defaults. */
export const contentfulSchemaInputSchema = z
  .object({
    contentTypeId: z
      .string()
      .min(1)
      .max(128)
      .regex(CONTENTFUL_ID)
      .nullable()
      .describe(
        "Content type ID to inspect. Null lists the space's content type catalog."
      ),
    limit: queryLimitSchema,
    skip: querySkipSchema,
    space: querySpaceSchema,
  })
  .strict();

/* Bounded native-query tool input; query parameter semantics are checked during execution. */
export const contentfulQueryInputSchema = z
  .object({
    includeArchived: z
      .boolean()
      .nullable()
      .describe(
        "Include archived entries in addition to published, changed, and draft entries. Null means false. Explicit query filters still apply."
      ),
    limit: queryLimitSchema,
    parameters: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            value: z.string().max(2000),
          })
          .strict()
      )
      .max(30)
      .describe(
        "Native CMA REST query parameters as name/value pairs, e.g. content_type=blogPost and fields.date[gte]=2026-01-01. Empty array uses defaults. Pagination belongs in limit/skip; include and locale are unsupported."
      ),
    resolveUsers: z
      .boolean()
      .nullable()
      .describe(
        "True resolves returned creator, last updater, and publisher IDs to names in users, with unresolvedUserIds reported separately. Deduplicates user lookups within this page. False or null returns actor IDs only without user requests."
      ),
    resultMode: z
      .enum(["fields", "references"])
      .nullable()
      .describe(
        "Null or fields returns selected values. Use references for component usage: scans selected configured-locale fields before body truncation and returns reference IDs, paths, and embed/hyperlink relationships, plus selected title/slug. Select the component-bearing fields explicitly; article prose is not returned."
      ),
    skip: querySkipSchema,
    space: querySpaceSchema,
  })
  .strict();

/**
 * Parsed content-type discovery input.
 *
 * @see {@link contentfulSchemaInputSchema}
 */
export type ContentfulSchemaInput = z.infer<typeof contentfulSchemaInputSchema>;

/**
 * Parsed structured-query input; nullable controls remain null until execution applies defaults.
 *
 * @see {@link contentfulQueryInputSchema}
 */
export type ContentfulQueryInput = z.infer<typeof contentfulQueryInputSchema>;

/* Shared bounded identifier schema for entry, field, asset-key, and recovery identifiers. */
export const updateFieldIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(CONTENTFUL_ID);

const contentfulEntryUpdateSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            fieldId: updateFieldIdSchema.describe(
              "Field ID from the entry's content type. Updates the selected translation, or the default-locale value for a shared field."
            ),
            operation: z
              .enum(["set", "unset", "patch"])
              .describe(
                "set replaces the whole value, unset removes it, and patch edits addressed blocks of a RichText field. Page bodies accept only patch."
              ),
            value: z
              .json()
              .describe(
                "For set: the complete replacement value, including the whole array for array fields. Supports text, numbers, booleans, ISO dates, Entry/Asset links, and arrays of supported values. Asset fields and Asset arrays also accept { newAsset: key } for an asset declared in assets. RichText document JSON is supported except for page bodies; supply the complete document, preserving existing formatting and references. For unset: null. For patch: { edits, embeds }. edits lists 1–50 edits addressed to block indexes and hashes from one read_contentful_content read: { type: 'replaceText', index, hash, find, replace } replaces one exact occurrence inside a single text run; { type: 'replaceBlocks', index, hashes, nodes } replaces hashes.length consecutive blocks from index with nodes (an empty array deletes them); { type: 'insertBlocks', afterIndex, afterHash, nodes } inserts after that block, or at the start when both are null. embeds is null to keep embedded entries and assets unchanged, or the complete ordered list of embedded IDs after the patch to confirm adding, removing, or moving embeds."
              ),
          })
          .strict()
      )
      .min(1)
      .max(20)
      .superRefine((changes, ctx) => {
        if (
          new Set(changes.map(({ fieldId }) => fieldId)).size !== changes.length
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Duplicate field IDs are not allowed.",
          });
        }
        if (JSON.stringify(changes).length > 100_000) {
          ctx.addIssue({
            code: "custom",
            message: "Field changes exceed 100,000 serialized characters.",
          });
        }
        for (const change of changes) {
          if ((change.operation === "unset") !== (change.value === null)) {
            ctx.addIssue({
              code: "custom",
              message: `${change.fieldId}: use null only with unset.`,
            });
          }
        }
      }),
    entryId: updateFieldIdSchema.describe(
      "Entry ID from a previous read or query."
    ),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1)
      .describe(
        "Entry version on which this operation is based. A stale version is rejected; read again before proposing another operation."
      ),
  })
  .strict();

/* Fixed batch of version-bound field updates; rejects duplicate entries and invalid field operations. */
/**
 * Validates a fixed batch of version-bound field updates, including duplicate entry and operation checks.
 */
export const contentfulUpdateInputSchema = z
  .object({
    entries: z
      .array(contentfulEntryUpdateSchema)
      .min(1)
      .max(20)
      .describe(
        "Fixed list of 1–20 entry updates in this space. Include each entry ID once, with its expected version and exact requested field changes. A single-entry edit uses a one-item array."
      ),
    space: querySpaceSchema,
  })
  .strict()
  .refine(
    ({ entries }) =>
      new Set(entries.map(({ entryId }) => entryId)).size === entries.length,
    { message: "Duplicate entry IDs are not allowed." }
  );

/**
 * Parsed batch field-update input.
 *
 * @see {@link contentfulUpdateInputSchema}
 */
export type ContentfulUpdateInput = z.infer<typeof contentfulUpdateInputSchema>;

/* Fixed publication roots and expected versions; dependency scope is discovered before approval. */
/**
 * Validates explicit publication roots and expected versions before dependency discovery and approval.
 */
export const contentfulPublishInputSchema = z
  .object({
    entries: z
      .array(
        contentfulEntryUpdateSchema.pick({
          entryId: true,
          expectedVersion: true,
        })
      )
      .min(1)
      .max(20)
      .describe(
        "Fixed list of 1–20 entries to publish in this space, each with its expected version. Single-entry publishing uses a one-item array. Publishing makes all pending changes on these versions live. A batch containing any page requires approval; component-only batches do not."
      ),
    space: querySpaceSchema,
  })
  .strict()
  .refine(
    ({ entries }) =>
      new Set(entries.map(({ entryId }) => entryId)).size === entries.length,
    { message: "Duplicate entry IDs are not allowed." }
  );

/**
 * Parsed publication input used to bind frozen plans to a tool call.
 *
 * @see {@link contentfulPublishInputSchema}
 */
export type ContentfulPublishInput = z.infer<
  typeof contentfulPublishInputSchema
>;

/* One parsed version-bound entry edit; shared validation also consumes its field-change structure. */
/**
 * One parsed version-bound entry edit with the exact field operations requested by the caller.
 */
export type ContentfulEntryUpdate = z.infer<typeof contentfulEntryUpdateSchema>;

/* File metadata common to URL imports and binary attachment uploads. */
const newContentfulAssetMetadataSchema = z
  .object({
    contentType: z
      .string()
      .max(128)
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u)
      .refine(
        (value) => !["text/html", "text/javascript"].includes(value),
        "Contentful does not process HTML or JavaScript assets."
      ),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[^/\\\r\n]+$/u, "Supply a filename, not a path."),
    key: updateFieldIdSchema.describe(
      "Temporary key referenced by { newAsset: key } in an Asset field."
    ),
    title: z.string().trim().min(1).max(256),
  })
  .strict();

/* Existing URL structure is retained so saved creation plans remain recoverable. */
export const newContentfulAssetSchema = z.union([
  newContentfulAssetMetadataSchema.extend({
    sourceUrl: z
      .url({ protocol: /^https$/u })
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return !(url.username || url.password || url.hash);
      }, "Use a public HTTPS file URL without credentials or a fragment.")
      .describe(
        "Public file URL Contentful can fetch without authentication, for example an injected Slack profile image URL."
      ),
  }),
  newContentfulAssetMetadataSchema.extend({
    sourcePath: z
      .string()
      .max(2048)
      .refine(isAssetFilePath)
      .describe(
        "Original image path under /workspace/.eve/attachments in the current session sandbox. Use this instead of sourceUrl for Slack attachments; PNG, JPEG, GIF, WebP, or AVIF, at most 20 MiB. Discover the actual path with file tools; never supply base64 or a private Slack URL."
      ),
  }),
]);

/* Model-facing updates share creation's asset declarations and explicit recovery controls. */
export const contentfulAssetUpdateInputSchema =
  contentfulUpdateInputSchema.safeExtend({
    assets: z
      .array(newContentfulAssetSchema)
      .min(1)
      .max(5)
      .nullable()
      .describe(
        "Up to five new assets shared across this update batch. Reference each key with { newAsset: key } in Asset fields or Asset arrays. Null means use existing values/references only. Assets are published; entry changes remain unpublished."
      ),
    resumeFrom: updateFieldIdSchema
      .nullable()
      .describe(
        "Null starts an update. To resume a partial update with assets, use its recoveryId with identical inputs. For a version conflict, read and reassess the entry, then use confirmed Asset IDs in a new update with assets:null; never re-upload the files."
      ),
  });

/**
 * Parsed entry-update batch with optional asset declarations and a session recovery selector.
 */
export type ContentfulAssetUpdateInput = z.infer<
  typeof contentfulAssetUpdateInputSchema
>;

/* Page draft and supporting-entry creation with nullable asset and recovery controls. */
export const contentfulCreateInputSchema = z
  .object({
    assets: z
      .array(newContentfulAssetSchema)
      .min(1)
      .max(5)
      .nullable()
      .describe(
        "Up to five new assets to create, process, and publish before this entry. Null means no new assets; ordinary published Asset links still work. Every key must be unique and referenced in fields."
      ),
    contentTypeId: updateFieldIdSchema.describe(
      "Content type ID from schema discovery. Page types are created as drafts; supporting entries are published."
    ),
    fields: z
      .array(
        z
          .object({
            fieldId: updateFieldIdSchema,
            value: z
              .json()
              .refine((value) => value !== null, {
                message:
                  "Creation field values cannot be null; omit unavailable fields for page drafts and unused optional fields for supporting entries.",
              })
              .describe(
                "The configured-locale field value, without a locale wrapper. Supports text, numbers, booleans, ISO dates, Entry/Asset links, and arrays of supported values. Asset fields and Asset arrays also accept { newAsset: key } for an asset declared in assets. RichText document JSON is supported, including a page's body when the page is created. Supply the complete document, preserving existing formatting and references."
              ),
          })
          .strict()
      )
      .max(20)
      .superRefine((fields, ctx) => {
        if (
          new Set(fields.map(({ fieldId }) => fieldId)).size !== fields.length
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Duplicate field IDs are not allowed.",
          });
        }
        if (JSON.stringify(fields).length > 100_000) {
          ctx.addIssue({
            code: "custom",
            message: "Creation fields exceed 100,000 serialized characters.",
          });
        }
      })
      .describe(
        "Available fields for a page draft; an empty array is allowed and missing required fields can be omitted. Supporting entries require at least one field and all required fields."
      ),
    resumeFrom: updateFieldIdSchema
      .nullable()
      .describe(
        "Null starts a new creation. To recover a partial page creation (with or without assets) or asset-backed supporting-entry creation in this session, supply its returned recoveryId and the identical space, contentTypeId, fields, and assets. Never start a replacement creation."
      ),
    space: querySpaceSchema,
  })
  .strict();

/**
 * Parsed creation/recovery input; configured-locale locale wrappers are added by preparation.
 *
 * @see {@link contentfulCreateInputSchema}
 */
export type ContentfulCreateInput = z.infer<typeof contentfulCreateInputSchema>;
