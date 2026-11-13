/* Asset processing shared by entry creation and field updates; no eve state dependency. */
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { isObject, isString } from "../../values";
import { ContentfulApiError, callApi } from "../api";
import { isLive, readString } from "../content";
import type {
  ContentfulCreateInput,
  newContentfulAssetSchema,
} from "../input-schemas";
import { contentLocale } from "../locale";
import { APP_HOST, QUERY_SPACES, spacePath } from "../model";
import type { RawEntry } from "../types";
import { assetFileSource, ensureAssetUpload } from "./uploads";
import type { AssetUploadState } from "./uploads";

/* Durable progress marker; an in-progress stage may precede an unconfirmed CMA write. */
export const assetRuntime = { delay };

/**
 * Durable resource progress; in-progress stages may represent writes whose response was not confirmed.
 */
export type CreationStage =
  | "notAttempted"
  | "uploading"
  | "uploaded"
  | "creating"
  | "created"
  | "processing"
  | "processed"
  | "publishing"
  | "published";

/**
 * Reserved resource identity and last confirmed version retained across explicit recovery attempts.
 */
export interface CreationResource {
  /** Reserved before any write and retained throughout recovery. */
  id: string;
  stage: CreationStage;
  /** Last confirmed version, or null when creation has not been confirmed. */
  version: number | null;
}

/* Structural asset view; existing creation plans retain their serialized fields unchanged. */
/**
 * Shared asset plan carried by recoverable entry creation and update operations.
 */
export interface ContentfulAssetPlan {
  configuration?: string;
  locale?: string;
  assets: (CreationResource & { key: string; upload?: AssetUploadState })[];
  input: Pick<ContentfulCreateInput, "space" | "assets">;
}

/**
 * Reserves deterministic asset IDs before any external write.
 *
 * @param input - Validated operation input containing optional asset declarations.
 * @param recoveryId - Stable operation ID used as the prefix for each reserved asset.
 * @returns Asset checkpoints in declaration order, initially unattempted with no confirmed version.
 */
export const reserveAssets = (
  input: ContentfulAssetPlan["input"],
  recoveryId: string
): ContentfulAssetPlan["assets"] =>
  (input.assets ?? []).map(({ key }, index) => ({
    id: `${recoveryId}-asset-${index}`,
    key,
    stage: "notAttempted",
    version: null,
  }));

/**
 * Reads a reserved resource while distinguishing unconfirmed creation from later deletion.
 *
 * @param path - CMA path of the reserved entry or asset.
 * @param resource - Checkpoint identifying whether creation was ever confirmed.
 * @param signal - Cancellation signal for the read request.
 * @returns The current resource, or null for a missing resource whose creation was never confirmed.
 * @throws {@link Error} When a confirmed resource is missing or the read otherwise fails.
 */
export const readCreationResource = async (
  path: string,
  resource: CreationResource,
  signal?: AbortSignal
) => {
  try {
    return await callApi<RawEntry>(path, {}, signal);
  } catch (error) {
    // An explicit recovery can repeat create-only PUT at the same reserved ID.
    // Confirmed resources that were subsequently deleted must never be recreated.
    if (
      error instanceof ContentfulApiError &&
      error.status === 404 &&
      resource.version === null
    ) {
      return null;
    }
    throw error;
  }
};

/**
 * Builds the CMA path for a resource reserved by an asset-backed operation.
 *
 * @param plan - Operation selecting the configured space and environment.
 * @param resource - Reserved entry or asset identity.
 * @param kind - CMA collection containing the resource.
 * @returns An allowlisted environment-qualified resource path.
 */
export const creationResourcePath = (
  plan: ContentfulAssetPlan,
  resource: CreationResource,
  kind: "entries" | "assets"
) => `${spacePath(QUERY_SPACES[plan.input.space])}/${kind}/${resource.id}`;

const assetFileUrlSchema = z.url({ protocol: /^https$/u });

const processedAssetUrl = (raw: RawEntry): string | null => {
  const file = raw.fields?.file?.[contentLocale()];
  if (!(file && isObject(file) && "url" in file && isString(file.url))) {
    return null;
  }
  const value = file.url.startsWith("//") ? `https:${file.url}` : file.url;
  const parsed = assetFileUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const verifyCreationAsset = (
  raw: RawEntry,
  expected: z.infer<typeof newContentfulAssetSchema>,
  upload?: AssetUploadState
) => {
  const file = raw.fields?.file?.[contentLocale()];
  if (
    !(
      file &&
      isObject(file) &&
      "fileName" in file &&
      file.fileName === expected.fileName &&
      "contentType" in file &&
      file.contentType === expected.contentType &&
      readString(raw.fields, "title") === expected.title
    )
  ) {
    throw new Error(
      `Asset ${raw.sys.id} no longer matches the requested file metadata.`
    );
  }
  if (!processedAssetUrl(raw)) {
    const source = assetFileSource(expected, upload);
    const actual =
      "sourceUrl" in expected
        ? { upload: "upload" in file ? file.upload : null }
        : { uploadFrom: "uploadFrom" in file ? file.uploadFrom : null };
    if (!isDeepStrictEqual(actual, source)) {
      throw new Error(`Asset ${raw.sys.id} no longer matches the file source.`);
    }
  }
};

const creationVersion = (raw: Partial<RawEntry>, id: string) => {
  const version = raw.sys?.version;
  if (
    raw.sys?.id !== id ||
    !Number.isSafeInteger(version) ||
    !version ||
    version < 1 ||
    raw.sys.archivedVersion !== undefined
  ) {
    throw new Error(`Invalid or archived creation resource ${id}.`);
  }
  return { sys: raw.sys, version };
};

/**
 * Rejects resource versions or publication states inconsistent with recorded operation progress.
 *
 * @param raw - Current CMA resource metadata being reconciled.
 * @param resource - Durable checkpoint containing the reserved ID, prior version, and stage.
 * @param processed - Whether asset processing has produced a verified HTTPS file URL.
 * @throws {@link Error} When identity, version, archival, or publication metadata indicates an external change.
 * @remarks Expected processing and publication increments are accepted after uncertain responses.
 */
export const verifyCreationVersion = (
  raw: Partial<RawEntry>,
  resource: CreationResource,
  processed: boolean
) => {
  const { sys, version } = creationVersion(raw, resource.id);
  const original = resource.version;
  const processingFinished =
    resource.stage === "processing" &&
    original !== null &&
    version === original + 1 &&
    processed &&
    !isLive(sys);
  const publishingFinished =
    resource.stage === "publishing" &&
    original !== null &&
    version === original + 1 &&
    sys.publishedVersion === original;
  if (
    !(version === (original ?? 1) || processingFinished || publishingFinished)
  ) {
    throw new Error(
      `${resource.id} changed outside this creation. Read it in Contentful before recovery; no newer version will be blindly published.`
    );
  }
  if (
    isLive(sys) &&
    !(
      publishingFinished ||
      (resource.stage === "published" && sys.publishedVersion === version - 1)
    )
  ) {
    throw new Error(`${resource.id} has an unexpected publication state.`);
  }
};

/**
 * Updates a resource checkpoint from a previously verified CMA read.
 *
 * @param raw - Resource whose identity and version passed verifyCreationVersion.
 * @param resource - Mutable checkpoint to advance to the confirmed version and stage.
 * @param processed - Whether a verified asset file URL confirms processing completed.
 * @remarks Callers must validate the read before applying it to durable progress.
 */
export const recordCreationRead = (
  raw: RawEntry,
  resource: CreationResource,
  processed: boolean
) => {
  // SAFETY: Every caller first runs verifyCreationVersion, which requires a positive safe-integer version.
  resource.version = raw.sys.version as number;
  if (isLive(raw.sys)) {
    resource.stage = "published";
  } else if (processed) {
    resource.stage = "processed";
  } else if (resource.stage === "creating") {
    resource.stage = "created";
  }
};

const refreshCreationAsset = async (
  plan: ContentfulAssetPlan,
  index: number,
  signal?: AbortSignal
) => {
  const asset = plan.assets[index];
  const raw = await readCreationResource(
    creationResourcePath(plan, asset, "assets"),
    asset,
    signal
  );
  if (!raw) {
    return;
  }
  verifyCreationAsset(raw, (plan.input.assets ?? [])[index], asset.upload);
  const processed = processedAssetUrl(raw) !== null;
  verifyCreationVersion(raw, asset, processed);
  recordCreationRead(raw, asset, processed);
};

/**
 * Reconciles every previously attempted asset before resuming an entry operation.
 *
 * @param plan - Plan whose asset versions and stages are updated from verified CMA reads.
 * @param signal - Cancellation signal for reconciliation requests.
 * @returns Completes after every attempted asset has been checked.
 * @throws {@link Error} When an asset changed outside the operation or has an incompatible publication state.
 */
export const refreshAssets = async (
  plan: ContentfulAssetPlan,
  signal?: AbortSignal
) => {
  for await (const index of plan.assets.keys()) {
    if (plan.assets[index].stage !== "notAttempted") {
      await refreshCreationAsset(plan, index, signal);
    }
  }
};

const waitForCreationAsset = async (
  plan: ContentfulAssetPlan,
  index: number,
  record: () => void,
  signal?: AbortSignal
) => {
  for await (const attempt of Array.from(
    { length: 10 },
    (_, attemptIndex) => attemptIndex
  )) {
    if (attempt > 0) {
      await assetRuntime.delay(1000, undefined, { signal });
    }
    await refreshCreationAsset(plan, index, signal);
    record();
    if (plan.assets[index].stage === "processed") {
      return;
    }
  }
  throw new Error(
    `Asset ${plan.assets[index].id} is still processing. Resume this recoveryId later; do not recreate it.`
  );
};

/**
 * Publishes one reserved entry or asset using its last confirmed version.
 *
 * @param plan - Operation identifying the configured destination space.
 * @param resource - Mutable checkpoint advanced before and after the publication request.
 * @param kind - Resource collection, entries or assets.
 * @param record - Persists the in-progress marker and confirmed publication receipt.
 * @param signal - Cancellation signal checked before the write.
 * @returns Completes after the response confirms identity and the expected publication increment.
 * @throws {@link Error} When publication fails or the returned version cannot confirm success.
 */
export const publishCreationResource = async (
  plan: ContentfulAssetPlan,
  resource: CreationResource,
  kind: "entries" | "assets",
  record: () => void,
  signal?: AbortSignal
) => {
  signal?.throwIfAborted();
  resource.stage = "publishing";
  record();
  const { version } = resource;
  const published = await callApi<RawEntry>(
    `${creationResourcePath(plan, resource, kind)}/published`,
    {},
    signal,
    { headers: { "X-Contentful-Version": String(version) }, method: "PUT" }
  );
  if (
    published.sys?.id !== resource.id ||
    published.sys.publishedVersion !== version ||
    published.sys.version !== (version ?? 0) + 1
  ) {
    throw new Error(`Publication of ${resource.id} could not be confirmed.`);
  }
  resource.stage = "published";
  resource.version = published.sys.version;
  record();
};

const createAndPublishAsset = async (
  plan: ContentfulAssetPlan,
  index: number,
  files: Map<number, Uint8Array>,
  record: () => void,
  signal?: AbortSignal
) => {
  const asset = plan.assets[index];
  const spec = (plan.input.assets ?? [])[index];
  const path = creationResourcePath(plan, asset, "assets");
  if (asset.version === null) {
    await ensureAssetUpload(plan, index, files, record, signal);
    signal?.throwIfAborted();
    asset.stage = "creating";
    record();
    const raw = await callApi<RawEntry>(path, {}, signal, {
      body: JSON.stringify({
        fields: {
          file: {
            [contentLocale()]: {
              contentType: spec.contentType,
              fileName: spec.fileName,
              ...assetFileSource(spec, asset.upload),
            },
          },
          title: { [contentLocale()]: spec.title },
        },
      }),
      headers: {
        "Content-Type": "application/vnd.contentful.management.v1+json",
      },
      method: "PUT",
    });
    verifyCreationAsset(raw, spec, asset.upload);
    verifyCreationVersion(raw, asset, false);
    // SAFETY: verifyCreationVersion above checked this resource identity and positive safe-integer version.
    asset.version = raw.sys.version as number;
    asset.stage = "created";
    record();
  }
  if (asset.stage === "published") {
    return;
  }
  if (asset.stage !== "processed") {
    signal?.throwIfAborted();
    asset.stage = "processing";
    record();
    await callApi<undefined>(
      `${path}/files/${contentLocale()}/process`,
      {},
      signal,
      {
        headers: { "X-Contentful-Version": String(asset.version) },
        method: "PUT",
      }
    );
    await waitForCreationAsset(plan, index, record, signal);
  }
  await publishCreationResource(plan, asset, "assets", record, signal);
};

/**
 * Creates, processes, and publishes assets sequentially, stopping on the first failure.
 *
 * @param plan - Durable operation containing reserved asset IDs and current progress.
 * @param files - Validated attachment bytes keyed by asset index for this invocation only.
 * @param record - Persists progress before uncertain writes and after confirmed transitions.
 * @param signal - Cancellation signal for asset requests and processing waits.
 * @returns Completes only after all declared assets are confirmed published.
 */
export const publishAssets = async (
  plan: ContentfulAssetPlan,
  files: Map<number, Uint8Array>,
  record: () => void,
  signal?: AbortSignal
) => {
  for await (const index of plan.assets.keys()) {
    await createAndPublishAsset(plan, index, files, record, signal);
  }
};

/**
 * Projects durable asset checkpoints into user-visible progress without implying creation succeeded.
 *
 * @param plan - Operation containing reserved identities and confirmed asset stages.
 * @returns Asset IDs, editor links, stages, versions, and available upload receipts.
 */
export const assetResults = (plan: ContentfulAssetPlan) =>
  plan.assets.map((asset) => ({
    assetId: asset.id,
    contentfulUrl: `${APP_HOST}${creationResourcePath(plan, asset, "assets")}`,
    key: asset.key,
    stage: asset.stage,
    ...(asset.upload && {
      upload: {
        expiresAt: asset.upload.expiresAt,
        id: asset.upload.id,
        status: asset.upload.status,
      },
    }),
    version: asset.version,
  }));
