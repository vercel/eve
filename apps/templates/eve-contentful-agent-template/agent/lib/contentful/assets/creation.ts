import { isDeepStrictEqual } from "node:util";

import type { JsonValue } from "../../json";
import { callApi } from "../api";
/**
 * Recoverable page and asset-backed creation using reserved IDs and recorded resource progress.
 * State persistence is supplied by the caller; this module does not depend on eve.
 *
 * @packageDocumentation
 */
import { configurationKey } from "../config";
import { prepareCreation } from "../create";
import {
  contentfulCreateInputSchema,
  updateFieldIdSchema,
} from "../input-schemas";
import type { ContentfulCreateInput } from "../input-schemas";
import { contentLocale } from "../locale";
import { APP_HOST } from "../model";
import type { LocalizedFields, RawEntry } from "../types";
import type { ReadAssetFile } from "./files";
import { resolveAssetFields } from "./placeholders";
import { prepareAssetUploads } from "./uploads";
import type { AssetUploadState } from "./uploads";
import {
  assetResults,
  creationResourcePath,
  publishAssets,
  publishCreationResource,
  readCreationResource,
  recordCreationRead,
  refreshAssets,
  reserveAssets,
  verifyCreationVersion,
} from "./workflow";
import type {
  ContentfulAssetPlan,
  CreationResource,
  CreationStage,
} from "./workflow";

/* Serializable create-only resource identities, input, and progress for explicit recovery. */
/**
 * Serializable create-only resource identities, frozen inputs, and progress retained for explicit recovery.
 */
export interface ContentfulAssetCreationPlan extends ContentfulAssetPlan {
  entry: CreationResource;
  /** Last execution failure; cleared when an explicit recovery attempt starts. */
  error: string | null;
  /** Prepared configured-locale fields with placeholders replaced by reserved asset links. */
  fields: LocalizedFields;
  /** Original parsed input with resumeFrom normalized to null. */
  input: ContentfulCreateInput;
  /** Intended terminal state; legacy plans without this field target publication. */
  publicationTarget?: "draft" | "published";
  /** Session recovery selector and prefix for reserved resource IDs. */
  recoveryId: string;
}

/* Per-resource progress; a reserved ID alone does not confirm successful creation. */
/**
 * Per-resource creation receipts; a reserved ID confirms identity allocation, while its stage confirms progress.
 */
export interface ContentfulAssetCreationResult {
  assets: {
    assetId: string;
    contentfulUrl: string;
    key: string;
    stage: CreationStage;
    upload?: Pick<AssetUploadState, "id" | "status" | "expiresAt">;
    version: number | null;
  }[];
  /** The entry reached its target, all assets are published, and no error remains. */
  complete: boolean;
  entry: {
    contentfulUrl: string;
    entryId: string;
    stage: CreationStage;
    version: number | null;
  };
  /** Operation failure or cancellation detail, rather than a thrown execution error. */
  error: string | null;
  publicationTarget: "draft" | "published";
  recoveryId: string;
}

const normalize = (input: JsonValue) => ({
  ...contentfulCreateInputSchema.parse(input),
  resumeFrom: null,
});

/**
 * Compare parsed creation inputs, ignoring only the recovery selector.
 *
 * @param left - Original or saved creation input.
 * @param right - Proposed input for the same operation.
 * @returns Whether inputs match after normalizing `resumeFrom` to null; object key order is ignored.
 * @throws {@link Error} If either input fails the creation schema.
 */
export const contentfulCreationInputsMatch = (
  left: JsonValue,
  right: JsonValue
): boolean => isDeepStrictEqual(normalize(left), normalize(right));

/**
 * Validate an entry and its asset placeholders before any resource writes.
 *
 * @param input - Page or asset-backed creation input; every declared asset key must be referenced.
 * @param recoveryId - Stable operation ID used to derive reserved entry and asset IDs.
 * @param signal - Optional cancellation during model and existing-reference reads.
 * @returns A serializable plan with resolved fields and all resources marked unattempted.
 * @throws {@link Error} If input, placeholders, model fields, or existing references are invalid, or a read fails.
 * @remarks IDs are reserved locally, not created in CMA. Persist the plan before execution;
 * existing references must already be live. Page plans can have no assets and stop at draft creation.
 */
export const prepareContentfulAssetCreation = async (
  input: JsonValue,
  recoveryId: string,
  signal?: AbortSignal
): Promise<ContentfulAssetCreationPlan> => {
  const parsed = contentfulCreateInputSchema.parse(input);
  updateFieldIdSchema.parse(recoveryId);
  const assets = reserveAssets(parsed, recoveryId);
  const fields = resolveAssetFields(parsed.fields, assets);
  const prepared = await prepareCreation(
    contentfulCreateInputSchema.parse({ ...parsed, fields }),
    signal,
    new Set(assets.map(({ id }) => id))
  );
  if (!parsed.assets && prepared.publicationTarget !== "draft") {
    throw new Error("A supporting-entry creation plan requires assets.");
  }
  return {
    assets,
    configuration: configurationKey(),
    entry: { id: `${recoveryId}-entry`, stage: "notAttempted", version: null },
    error: null,
    fields: prepared.fields,
    input: { ...parsed, resumeFrom: null },
    locale: contentLocale(),
    publicationTarget: prepared.publicationTarget,
    recoveryId,
  };
};

const refreshCreationEntry = async (
  plan: ContentfulAssetCreationPlan,
  signal?: AbortSignal
) => {
  const raw = await readCreationResource(
    creationResourcePath(plan, plan.entry, "entries"),
    plan.entry,
    signal
  );
  if (!raw) {
    return;
  }
  if (
    raw.sys.contentType?.sys.id !== plan.input.contentTypeId ||
    !isDeepStrictEqual(raw.fields, plan.fields)
  ) {
    throw new Error(
      `Entry ${plan.entry.id} no longer matches the requested creation.`
    );
  }
  verifyCreationVersion(raw, plan.entry, false);
  recordCreationRead(raw, plan.entry, false);
};

/**
 * Report saved resource progress without reading or writing Contentful.
 *
 * @param plan - Saved plan, including the last error and confirmed versions.
 * @returns Resource IDs/stages and target; `complete` requires the target entry stage, published assets, and no error.
 * @remarks A reserved ID or in-progress stage does not confirm successful creation/publication.
 */
export const contentfulAssetCreationResult = (
  plan: ContentfulAssetCreationPlan
): ContentfulAssetCreationResult => {
  const publicationTarget = plan.publicationTarget ?? "published";
  const complete =
    plan.entry.stage ===
      (publicationTarget === "draft" ? "created" : "published") &&
    plan.entry.version !== null &&
    plan.assets.every((asset) => asset.stage === "published") &&
    plan.error === null;
  return {
    assets: assetResults(plan),
    complete,
    entry: {
      contentfulUrl: `${APP_HOST}${creationResourcePath(plan, plan.entry, "entries")}`,
      entryId: plan.entry.id,
      stage: plan.entry.stage,
      version: plan.entry.version,
    },
    error: plan.error,
    publicationTarget,
    recoveryId: plan.recoveryId,
  };
};

/**
 * Continue a saved creation, checking versions, content, and references before writes.
 *
 * @param plan - Persisted plan to reconcile and mutate; reserved resource IDs must remain stable.
 * @param save - Synchronous checkpoint callback receiving a structured clone of progress.
 * @param signal - Optional cancellation for reads, writes, and bounded processing waits.
 * @param readFile - Optional attachment reader; only needed for files not yet uploaded.
 * @returns Per-resource progress; operation failures and cancellation are reported in `error`.
 * @throws {@link Error} If saving the failure checkpoint itself fails.
 * @remarks Assets are created, processed, and published before their entry. Pages stop at
 * confirmed draft creation; supporting entries are then published. Recovery reads
 * existing resources and never overwrites them or replaces an uncertain creation. Progress
 * is not atomic with CMA writes; a failed create-only PUT can be repeated at its reserved ID
 * only through explicit recovery after a read confirms the resource is absent.
 */
export const executeContentfulAssetCreation = async (
  plan: ContentfulAssetCreationPlan,
  save: (plan: ContentfulAssetCreationPlan) => void,
  signal?: AbortSignal,
  readFile?: ReadAssetFile
): Promise<ContentfulAssetCreationResult> => {
  const record = () => save(structuredClone(plan));
  plan.error = null;
  try {
    signal?.throwIfAborted();
    const prepared = await prepareCreation(
      contentfulCreateInputSchema.parse({
        ...plan.input,
        fields: resolveAssetFields(plan.input.fields, plan.assets),
      }),
      signal,
      new Set(plan.assets.map(({ id }) => id))
    );
    if (
      prepared.publicationTarget !== (plan.publicationTarget ?? "published")
    ) {
      throw new Error(
        "Creation publication target no longer matches the content type. Inspect the saved operation before recovery."
      );
    }
    await refreshAssets(plan, signal);
    if (plan.entry.stage !== "notAttempted") {
      await refreshCreationEntry(plan, signal);
    }
    record();
    const files = await prepareAssetUploads(plan, readFile, record, signal);
    await publishAssets(plan, files, record, signal);
    if (contentfulAssetCreationResult(plan).complete) {
      return contentfulAssetCreationResult(plan);
    }
    signal?.throwIfAborted();
    if (plan.entry.version === null) {
      plan.entry.stage = "creating";
      record();
      const raw = await callApi<RawEntry>(
        creationResourcePath(plan, plan.entry, "entries"),
        {},
        signal,
        {
          body: JSON.stringify({ fields: plan.fields }),
          headers: {
            "Content-Type": "application/vnd.contentful.management.v1+json",
            "X-Contentful-Content-Type": plan.input.contentTypeId,
          },
          method: "PUT",
        }
      );
      if (
        raw.sys.contentType?.sys.id !== plan.input.contentTypeId ||
        !isDeepStrictEqual(raw.fields, plan.fields)
      ) {
        throw new Error("Entry creation returned unexpected content.");
      }
      verifyCreationVersion(raw, plan.entry, false);
      // SAFETY: verifyCreationVersion above checked the entry identity and positive safe-integer version.
      plan.entry.version = raw.sys.version as number;
      plan.entry.stage = "created";
      record();
    }
    if (prepared.publicationTarget === "published") {
      await publishCreationResource(
        plan,
        plan.entry,
        "entries",
        record,
        signal
      );
    }
  } catch (error) {
    plan.error = error instanceof Error ? error.message : String(error);
    record();
  }
  return contentfulAssetCreationResult(plan);
};
