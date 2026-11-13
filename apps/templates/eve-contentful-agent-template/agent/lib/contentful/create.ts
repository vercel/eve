import { callApi } from "./api";
import { environmentId } from "./config";
/**
 * Validate page drafts or supporting entries; direct creation publishes supporting entries only.
 *
 * @packageDocumentation
 */
import { isLive } from "./content";
import {
  updateLinks,
  validateUpdateChange,
  validateUpdateReferences,
} from "./field-validation";
import { contentfulCreateInputSchema } from "./input-schemas";
import type { ContentfulCreateInput } from "./input-schemas";
import { fieldLocale } from "./locale";
import type { ContentfulSpaceId } from "./model";
import {
  APP_HOST,
  CONTENTFUL_ID,
  pageKindInSpace,
  QUERY_SPACES,
  spacePath,
} from "./model";
import type { RawContentType, RawEntry } from "./types";

/* Validated creation payload; producing it performs reads but no writes. */
interface PreparedCreation {
  base: string;
  fields: Record<
    string,
    Record<string, ContentfulCreateInput["fields"][number]["value"]>
  >;
  publicationTarget: "draft" | "published";
  spaceId: ContentfulSpaceId;
}

/* The confirmed new identity, retained even when its publication is uncertain. */
interface CreatedEntryIdentity {
  contentfulUrl: string;
  contentTypeId: string;
  entryId: string;
  environmentId: string;
  outcome: "created";
  spaceId: ContentfulSpaceId;
}

/* Creation succeeded in both branches; only `published` confirms publication. */
/**
 * Confirmed new entry identity with either a verified publication receipt or an explicitly uncertain publication outcome.
 */
export type ContentfulCreationResult = CreatedEntryIdentity &
  (
    | { publication: "published"; version: number | undefined }
    | { error: string; publication: "unconfirmed"; version: number | null }
  );

/**
 * Validate page draft or supporting-entry creation without making writes.
 *
 * @param input - Parsed creation input with asset placeholders already replaced by reserved links.
 * @param signal - Optional cancellation for model/reference reads and preflight checks.
 * @param pendingAssets - Reserved assets owned by this operation; exempt from live-target lookup.
 * @returns A localized field payload, environment path, and configured space ID.
 * @throws {@link Error} If supplied fields/references are invalid, a supporting entry is incomplete, or a read fails.
 * @remarks Only explicitly configured component types bypass draft creation. Pages may omit required fields,
 * including all fields. Supplied values are still validated. External references
 * must already be live; this function does not publish their pending changes.
 */
export const prepareCreation = async (
  input: ContentfulCreateInput,
  signal?: AbortSignal,
  pendingAssets: ReadonlySet<string> = new Set()
): Promise<PreparedCreation> => {
  signal?.throwIfAborted();
  const spaceId = QUERY_SPACES[input.space];
  const publicationTarget = pageKindInSpace(spaceId, input.contentTypeId)
    ? "draft"
    : "published";
  if (publicationTarget === "published" && input.fields.length === 0) {
    throw new Error("Supporting-entry creation requires at least one field.");
  }
  const base = spacePath(spaceId);
  const model = await callApi<RawContentType>(
    `${base}/content_types/${input.contentTypeId}`,
    {},
    signal
  );
  if (model.sys.id !== input.contentTypeId) {
    throw new Error(
      "Contentful returned a different content type than requested."
    );
  }
  const changes = input.fields.map((field) => ({
    ...field,
    operation: "set" as const,
  }));
  for (const field of model.fields) {
    if (
      publicationTarget === "published" &&
      field.required &&
      !changes.some((change) => change.fieldId === field.id)
    ) {
      throw new Error(
        `Required field ${field.id} must be supplied before creation.`
      );
    }
  }
  for (const change of changes) {
    const field = model.fields.find(({ id }) => id === change.fieldId);
    if (!field) {
      throw new Error(
        `Unknown field ${change.fieldId} on content type ${input.contentTypeId}.`
      );
    }
    validateUpdateChange(field, change, {
      contentTypeId: input.contentTypeId,
      operation: "create",
      space: input.space,
    });
  }
  const allLinks = changes.flatMap(updateLinks);
  if (
    new Set(allLinks.map((link) => `${link.sys.linkType}:${link.sys.id}`))
      .size > 100
  ) {
    throw new Error("Creation fields exceed 100 distinct references.");
  }
  await validateUpdateReferences(
    base,
    model,
    changes,
    signal,
    true,
    pendingAssets
  );
  signal?.throwIfAborted();
  return {
    base,
    fields: Object.fromEntries(
      input.fields.map(({ fieldId, value }) => [
        fieldId,
        {
          [fieldLocale(
            model.fields.find((field) => field.id === fieldId) ?? {}
          )]: value,
        },
      ])
    ),
    publicationTarget,
    spaceId,
  };
};

const createdVersion = (created: RawEntry, contentTypeId: string): number => {
  const { version } = created.sys;
  if (
    !(Number.isSafeInteger(version) && version) ||
    version < 1 ||
    version >= Number.MAX_SAFE_INTEGER ||
    created.sys.contentType?.sys.id !== contentTypeId
  ) {
    throw new Error(
      "Creation returned no valid version or matching content type to publish."
    );
  }
  return version;
};

/**
 * Create one supporting entry and publish only its returned ID/version, without retries.
 *
 * @param input - Creation input with both `assets` and `resumeFrom` set to null.
 * @param signal - Optional cancellation; after creation, interruption retains the returned ID.
 * @returns The created identity and a `published` or `unconfirmed` publication outcome.
 * @throws {@link Error} If validation fails, creation cannot be confirmed, or no usable entry ID is returned.
 * @remarks Publication failure is returned rather than thrown once a valid new ID is known.
 * Read CMA before retrying uncertain creation; never create a replacement automatically.
 * External references must already be live, and their pending changes are not published.
 */
export const createContentfulEntry = async (
  input: ContentfulCreateInput,
  signal?: AbortSignal
): Promise<ContentfulCreationResult> => {
  const parsed = contentfulCreateInputSchema.parse(input);
  if (pageKindInSpace(QUERY_SPACES[parsed.space], parsed.contentTypeId)) {
    throw new Error(
      "Page content type creation requires the saved creation workflow."
    );
  }
  if (parsed.assets !== null || parsed.resumeFrom !== null) {
    throw new Error(
      "Asset-backed creation requires the saved creation workflow."
    );
  }
  const prepared = await prepareCreation(parsed, signal);
  let created: RawEntry;
  try {
    created = await callApi<RawEntry>(`${prepared.base}/entries`, {}, signal, {
      body: JSON.stringify({ fields: prepared.fields }),
      headers: {
        "Content-Type": "application/vnd.contentful.management.v1+json",
        "X-Contentful-Content-Type": parsed.contentTypeId,
      },
      method: "POST",
    });
  } catch (error) {
    throw new Error(
      `Creation failed or could not be confirmed. Query for the entry before retrying; this call will not retry automatically. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  const entryId = created?.sys?.id;
  if (!entryId || entryId.length > 128 || !CONTENTFUL_ID.test(entryId)) {
    throw new Error(
      "Creation returned no valid entry ID. Query for the entry before retrying; publication was not attempted."
    );
  }
  const path = `${prepared.base}/entries/${entryId}`;
  const identity = {
    contentTypeId: parsed.contentTypeId,
    contentfulUrl: `${APP_HOST}${path}`,
    entryId,
    environmentId: environmentId(),
    outcome: "created" as const,
    spaceId: prepared.spaceId,
  };
  try {
    signal?.throwIfAborted();
    const version = createdVersion(created, parsed.contentTypeId);
    const published = await callApi<RawEntry>(`${path}/published`, {}, signal, {
      headers: { "X-Contentful-Version": String(version) },
      method: "PUT",
    });
    if (
      published.sys.id !== entryId ||
      !isLive(published.sys) ||
      !Number.isSafeInteger(published.sys.version) ||
      (published.sys.version ?? 0) <= version
    ) {
      throw new Error(
        "Contentful did not confirm publication of the created entry."
      );
    }
    return {
      ...identity,
      publication: "published" as const,
      version: published.sys.version,
    };
  } catch (error) {
    // Creation succeeded. Preserve its ID even if cancellation or an uncertain
    // publication prevents completing the operation; never create a replacement.
    return {
      ...identity,
      error: error instanceof Error ? error.message : String(error),
      publication: "unconfirmed" as const,
      version: created.sys.version ?? null,
    };
  }
};
