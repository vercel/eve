/* Recoverable asset-backed updates. Assets publish; existing entries are only saved. */
import { isDeepStrictEqual } from "node:util";

import type { JsonValue } from "../../json";
import { callApi } from "../api";
import { configurationKey } from "../config";
import {
  contentfulAssetUpdateInputSchema,
  updateFieldIdSchema,
} from "../input-schemas";
import type {
  ContentfulAssetUpdateInput,
  ContentfulEntryUpdate,
} from "../input-schemas";
import { contentLocale } from "../locale";
import type { RawQueryEntry } from "../types";
import {
  prepareUpdate,
  savedUpdateResult,
  savePreparedUpdate,
} from "../update";
import type { PreparedUpdate } from "../update";
import type { ReadAssetFile } from "./files";
import { resolveAssetFields } from "./placeholders";
import { prepareAssetUploads } from "./uploads";
import {
  assetResults,
  publishAssets,
  refreshAssets,
  reserveAssets,
} from "./workflow";
import type { ContentfulAssetPlan } from "./workflow";

interface UpdateProgress {
  error: string | null;
  prepared: PreparedUpdate;
  request: ContentfulEntryUpdate;
  result: ReturnType<typeof savedUpdateResult> | null;
  stage: "notAttempted" | "saving" | "saved";
}

/* Stored separately from creation plans; all source and entry inputs remain fixed. */
/**
 * Frozen entry-update batch and shared asset checkpoints retained for explicit recovery.
 */
export interface ContentfulAssetUpdatePlan extends ContentfulAssetPlan {
  entries: UpdateProgress[];
  error: string | null;
  input: ContentfulAssetUpdateInput;
  recoveryId: string;
}

/* Resolve keys once across every entry, allowing one asset in multiple fields and entries. */
const resolvedEntries = (
  input: ContentfulAssetUpdateInput,
  assets: ContentfulAssetPlan["assets"]
) => {
  const changes = resolveAssetFields(
    input.entries.flatMap((entry) => entry.changes),
    assets
  );
  let offset = 0;
  return input.entries.map((entry) => {
    const resolved = {
      ...entry,
      changes: changes.slice(offset, offset + entry.changes.length),
    };
    offset += entry.changes.length;
    return resolved;
  });
};

/**
 * Freezes the complete entry-update batch before uploading or creating assets.
 *
 * @param input - Untrusted JSON parsed by the asset-update schema.
 * @param recoveryId - Stable validated identifier used to reserve asset IDs.
 * @param signal - Cancellation signal for read-only update preparation.
 * @returns A durable plan with validated entry snapshots and reserved asset checkpoints.
 * @throws {@link Error} When input, entry versions, fields, or references are invalid.
 */
export const prepareContentfulAssetUpdate = async (
  input: JsonValue,
  recoveryId: string,
  signal?: AbortSignal
): Promise<ContentfulAssetUpdatePlan> => {
  const parsed = contentfulAssetUpdateInputSchema.parse(input);
  updateFieldIdSchema.parse(recoveryId);
  if (!parsed.assets) {
    throw new Error("An asset-backed update requires declared assets.");
  }
  const assets = reserveAssets(parsed, recoveryId);
  const pendingAssets = new Set(assets.map(({ id }) => id));
  const entries: UpdateProgress[] = [];
  for await (const request of resolvedEntries(parsed, assets)) {
    const prepared = await prepareUpdate(
      parsed.space,
      request,
      signal,
      pendingAssets
    );
    entries.push({
      error: null,
      prepared,
      request,
      result: null,
      stage: "notAttempted",
    });
  }
  return {
    assets,
    configuration: configurationKey(),
    entries,
    error: null,
    input: { ...parsed, resumeFrom: null },
    locale: contentLocale(),
    recoveryId,
  };
};

/* Contentful may omit an empty locale map after unsetting a field. */
const comparableContent = (content: {
  fields?: RawQueryEntry["fields"];
  metadata?: JsonValue;
}) => ({
  fields: Object.fromEntries(
    Object.entries(content.fields ?? {}).filter(
      ([, locales]) => Object.keys(locales).length > 0
    )
  ),
  ...(!(content.metadata === undefined) && { metadata: content.metadata }),
});

const sameContent = (raw: RawQueryEntry, body: string) =>
  isDeepStrictEqual(
    comparableContent(raw),
    comparableContent(JSON.parse(body))
  );

const updateConflict = (entryId: string): Error =>
  new Error(
    `Entry ${entryId} changed or its save cannot be confirmed. Read and reassess it; reuse the returned published Asset IDs in a new update with assets:null. Do not upload replacements.`
  );

/* Reconcile an interrupted save before deciding whether that exact write may resume. */
const refreshUpdate = async (entry: UpdateProgress, signal?: AbortSignal) => {
  if (entry.stage === "saved") {
    return;
  }
  const { prepared } = entry;
  const raw = await callApi<RawQueryEntry>(prepared.path, {}, signal);
  if (
    raw.sys.id !== prepared.entryId ||
    raw.sys.contentType?.sys.id !== prepared.contentTypeId ||
    raw.sys.archivedVersion !== undefined ||
    (raw.sys.publishedVersion ?? null) !== prepared.publishedVersion
  ) {
    throw updateConflict(prepared.entryId);
  }
  if (
    raw.sys.version === prepared.expectedVersion &&
    sameContent(raw, prepared.before)
  ) {
    entry.stage = "notAttempted";
    entry.error = null;
    return;
  }
  if (
    entry.stage === "saving" &&
    raw.sys.version === prepared.expectedVersion + 1 &&
    sameContent(raw, prepared.body)
  ) {
    entry.result = savedUpdateResult(prepared, raw);
    entry.stage = "saved";
    entry.error = null;
    return;
  }
  throw updateConflict(prepared.entryId);
};

const comparableUpdate = (prepared: PreparedUpdate) => ({
  ...prepared,
  before: comparableContent(JSON.parse(prepared.before)),
  body: comparableContent(JSON.parse(prepared.body)),
});

/* Revalidate current schemas, references, and versions while retaining the frozen payload. */
const validatePendingUpdates = async (
  plan: ContentfulAssetUpdatePlan,
  pendingAssets: ReadonlySet<string>,
  signal?: AbortSignal
) => {
  for await (const entry of plan.entries) {
    if (entry.stage === "saved") {
      continue;
    }

    const current = await prepareUpdate(
      plan.input.space,
      entry.request,
      signal,
      pendingAssets
    );
    if (
      !isDeepStrictEqual(
        comparableUpdate(current),
        comparableUpdate(entry.prepared)
      )
    ) {
      throw updateConflict(entry.request.entryId);
    }
  }
};

/**
 * Reports confirmed entry saves and asset progress after a completed or interrupted batch.
 *
 * @param plan - Durable update plan containing the latest recorded outcomes.
 * @returns Completion status, recovery ID, asset receipts, and ordered per-entry outcomes.
 */
export const contentfulAssetUpdateResult = (
  plan: ContentfulAssetUpdatePlan
) => ({
  assets: assetResults(plan),
  complete:
    plan.error === null &&
    plan.entries.every((entry) => entry.stage === "saved"),
  error: plan.error,
  recoveryId: plan.recoveryId,
  results: plan.entries.map((entry) => {
    if (entry.result) {
      return { ...entry.result, outcome: "updated" as const };
    }
    if (entry.stage === "saving") {
      return {
        entryId: entry.request.entryId,
        error: entry.error ?? "Save is unconfirmed; resume to reconcile it.",
        outcome: "failed" as const,
      };
    }
    return {
      entryId: entry.request.entryId,
      outcome: "notAttempted" as const,
    };
  }),
});

/**
 * Resumes a frozen asset-backed batch without repeating confirmed saves or publishing entries.
 *
 * @param plan - Cloned durable plan whose current resources must be reconciled before writes.
 * @param save - Persists a cloned checkpoint after each relevant transition.
 * @param signal - Cancellation signal for reads, writes, and asset processing.
 * @param readFile - Optional session attachment reader for assets not yet uploaded.
 * @returns Current recovery receipts, including partial outcomes when execution fails.
 * @remarks Assets publish first; existing entry fields are then saved at their prepared versions.
 */
export const executeContentfulAssetUpdate = async (
  plan: ContentfulAssetUpdatePlan,
  save: (plan: ContentfulAssetUpdatePlan) => void,
  signal?: AbortSignal,
  readFile?: ReadAssetFile
) => {
  const record = () => save(structuredClone(plan));
  plan.error = null;
  try {
    signal?.throwIfAborted();
    for await (const entry of plan.entries) {
      await refreshUpdate(entry, signal);
      record();
    }
    if (plan.entries.every((entry) => entry.stage === "saved")) {
      return contentfulAssetUpdateResult(plan);
    }
    await validatePendingUpdates(
      plan,
      new Set(plan.assets.map(({ id }) => id)),
      signal
    );
    await refreshAssets(plan, signal);
    record();
    const files = await prepareAssetUploads(plan, readFile, record, signal);
    await publishAssets(plan, files, record, signal);
    await refreshAssets(plan, signal);
    record();
    // All assets now exist. Validate references normally and catch edits made during upload.
    await validatePendingUpdates(plan, new Set(), signal);
    for await (const entry of plan.entries) {
      if (entry.stage === "saved") {
        continue;
      }
      signal?.throwIfAborted();
      entry.stage = "saving";
      record();
      try {
        entry.result = await savePreparedUpdate(entry.prepared, signal);
        entry.stage = "saved";
        record();
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
  } catch (error) {
    plan.error = error instanceof Error ? error.message : String(error);
    record();
  }
  return contentfulAssetUpdateResult(plan);
};
