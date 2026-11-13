import { callApi } from "./api";
/**
 * Prepare all entry edits before sequential version-bound saves. Saving never publishes.
 *
 * @packageDocumentation
 */
import { entryStatus } from "./content";
import {
  referenceChange,
  resolveUpdateChange,
  validateUpdateChange,
  validateUpdateReferences,
} from "./field-validation";
import { contentfulUpdateInputSchema } from "./input-schemas";
import type {
  ContentfulEntryUpdate,
  ContentfulUpdateInput,
} from "./input-schemas";
import { fieldLocale } from "./locale";
import { APP_HOST, CONTENTFUL_ID, QUERY_SPACES, spacePath } from "./model";
import type { RawContentType, RawEntry, RawQueryEntry } from "./types";

/**
 * Reads one entry and validates all requested changes without writing to Contentful.
 *
 * @param space - Configured space alias or ID from the validated update input.
 * @param parsed - Entry identity, expected version, and requested field changes.
 * @param signal - Cancellation signal for entry, schema, and reference reads.
 * @param pendingAssets - Asset IDs reserved by the same prepared operation but not yet published.
 * @returns Before/after snapshots and identity metadata for a version-bound save.
 * @throws {@link Error} When the version, field values, schema, policy, or linked resources fail validation.
 */
export const prepareUpdate = async (
  space: ContentfulUpdateInput["space"],
  parsed: ContentfulEntryUpdate,
  signal?: AbortSignal,
  pendingAssets: ReadonlySet<string> = new Set()
) => {
  signal?.throwIfAborted();
  const spaceId = QUERY_SPACES[space];
  const base = spacePath(spaceId);
  const path = `${base}/entries/${parsed.entryId}`;
  const entry = await callApi<RawQueryEntry>(path, {}, signal);
  if (
    entry.sys.id !== parsed.entryId ||
    entry.sys.version !== parsed.expectedVersion
  ) {
    throw new Error(
      "Entry identity or version has changed. Read the entry again and reassess the requested changes before retrying."
    );
  }
  if (entryStatus(entry.sys) === "archived") {
    throw new Error(
      "Archived entries cannot be updated. Unarchive the entry in Contentful first."
    );
  }
  const contentTypeId = entry.sys.contentType?.sys.id;
  if (!(contentTypeId && CONTENTFUL_ID.test(contentTypeId))) {
    throw new Error("Contentful did not return a valid entry content type.");
  }
  const model = await callApi<RawContentType>(
    `${base}/content_types/${contentTypeId}`,
    {},
    signal
  );
  if (model.sys.id !== contentTypeId) {
    throw new Error(
      "Contentful returned a different content type than requested."
    );
  }
  const fields = new Map(Object.entries(entry.fields ?? {}));
  for (const change of parsed.changes) {
    const field = model.fields.find(({ id }) => id === change.fieldId);
    if (!field) {
      throw new Error(
        `Unknown field ${change.fieldId} on content type ${contentTypeId}.`
      );
    }
    const locales = { ...fields.get(change.fieldId) };
    const selectedLocale = fieldLocale(field);
    const write = resolveUpdateChange(field, change, locales[selectedLocale]);
    validateUpdateChange(field, write, { contentTypeId, space });
    if (change.operation === "unset") {
      fields.set(
        change.fieldId,
        Object.fromEntries(
          Object.entries(locales).filter(
            ([locale]) => locale !== selectedLocale
          )
        )
      );
    } else {
      locales[selectedLocale] = write.value;
      fields.set(change.fieldId, locales);
    }
  }
  await validateUpdateReferences(
    base,
    model,
    parsed.changes.map(referenceChange),
    signal,
    false,
    pendingAssets
  );
  signal?.throwIfAborted();
  return {
    before: JSON.stringify({
      fields: entry.fields ?? {},
      ...(!(entry.metadata === undefined) && { metadata: entry.metadata }),
    }),
    body: JSON.stringify({
      fields: Object.fromEntries(fields),
      ...(!(entry.metadata === undefined) && { metadata: entry.metadata }),
    }),
    contentTypeId,
    entryId: parsed.entryId,
    expectedVersion: parsed.expectedVersion,
    path,
    publishedVersion: entry.sys.publishedVersion ?? null,
    updatedFields: parsed.changes.map(({ fieldId }) => fieldId),
  };
};

/**
 * Validated entry snapshot and write payload bound to the version read during preparation.
 */
export type PreparedUpdate = Awaited<ReturnType<typeof prepareUpdate>>;

/**
 * Checks a save response before reporting that an entry update completed.
 *
 * @param update - Prepared operation containing the original version and requested entry ID.
 * @param updated - CMA response returned by the save request.
 * @returns Confirmed entry metadata and the fields included in the save.
 * @throws {@link Error} When the response ID or version does not match the expected save.
 */
export const savedUpdateResult = (
  update: PreparedUpdate,
  updated: RawEntry
) => {
  if (
    updated.sys.id !== update.entryId ||
    updated.sys.version !== update.expectedVersion + 1
  ) {
    throw new Error(
      `Save of ${update.entryId} could not be confirmed. Read it before retrying.`
    );
  }
  return {
    contentfulUrl: `${APP_HOST}${update.path}`,
    entryId: updated.sys.id,
    previousVersion: update.expectedVersion,
    status: entryStatus(updated.sys),
    updatedFields: update.updatedFields,
    version: updated.sys.version ?? null,
  };
};

/**
 * Sends the prepared entry snapshot with its expected version, without publishing or retrying.
 *
 * @param update - Validated payload returned by prepareUpdate.
 * @param signal - Cancellation signal checked before sending the save request.
 * @returns Confirmed saved identity, new version, status, editor link, and changed field IDs.
 * @throws {@link Error} When the save fails or its response cannot confirm the expected identity/version.
 */
export const savePreparedUpdate = async (
  update: PreparedUpdate,
  signal?: AbortSignal
) => {
  signal?.throwIfAborted();
  const updated = await callApi<RawEntry>(update.path, {}, signal, {
    body: update.body,
    headers: {
      "Content-Type": "application/vnd.contentful.management.v1+json",
      "X-Contentful-Version": String(update.expectedVersion),
    },
    method: "PUT",
  });
  return savedUpdateResult(update, updated);
};

type FieldUpdateResult =
  | ({ outcome: "updated" } & Awaited<ReturnType<typeof savePreparedUpdate>>)
  | { entryId: string; outcome: "failed"; error: string }
  | { entryId: string; outcome: "notAttempted" };

/* Ordered outcomes, including entries left untouched after the first save failure. */
interface ContentfulUpdateResult {
  complete: boolean;
  results: FieldUpdateResult[];
}

/**
 * Validate the complete batch, then save sequentially until the first failure.
 *
 * @param input - One space and 1–20 fixed entries, each with expected version and exact field changes.
 * @param signal - Optional cancellation for preparation and saves; cancellation rejects the call.
 * @returns Ordered updated/failed/unattempted results for a completed or partially failed batch.
 * @throws {@link Error} If input/preparation fails or cancellation occurs, including after earlier saves succeeded.
 * @remarks All entries validate before the first write. Each save uses its expected version,
 * preserves other locales and metadata, and never publishes. No retries or rollback occur.
 * After cancellation, read current CMA state rather than assuming no entries were saved.
 */
export const updateContentfulFields = async (
  input: ContentfulUpdateInput,
  signal?: AbortSignal
): Promise<ContentfulUpdateResult> => {
  const { space, entries } = contentfulUpdateInputSchema.parse(input);
  const prepared: PreparedUpdate[] = [];
  for await (const entry of entries) {
    try {
      prepared.push(await prepareUpdate(space, entry, signal));
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(
        `Entry ${entry.entryId} failed preparation; no entries were saved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  const results: FieldUpdateResult[] = [];
  for await (const [index, update] of prepared.entries()) {
    signal?.throwIfAborted();
    try {
      const saved = await savePreparedUpdate(update, signal);
      results.push({ ...saved, outcome: "updated" });
    } catch (error) {
      signal?.throwIfAborted();
      results.push(
        {
          entryId: update.entryId,
          error: error instanceof Error ? error.message : String(error),
          outcome: "failed",
        },
        ...prepared
          .slice(index + 1)
          .map(({ entryId }) => ({ entryId, outcome: "notAttempted" as const }))
      );
      break;
    }
  }
  return {
    complete: results.every(({ outcome }) => outcome === "updated"),
    results,
  };
};
