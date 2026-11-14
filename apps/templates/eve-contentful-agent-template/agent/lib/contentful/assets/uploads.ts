/* Binary upload preparation and checkpoints for the existing asset creation plan. */
import type { z } from "zod";

import { ContentfulApiError } from "../api";
import type { newContentfulAssetSchema } from "../input-schemas";
import { QUERY_SPACES } from "../model";
import { identifyAssetFile } from "./files";
import type { AssetFileIdentity, ReadAssetFile } from "./files";
import { createContentfulUpload, readContentfulUpload } from "./upload-api";
import type { ContentfulUpload } from "./upload-api";
import type { ContentfulAssetPlan } from "./workflow";

/* Optional on old URL-only plans; binary bytes are never stored here. */
/**
 * Durable upload checkpoint containing file identity and confirmed upload metadata, never binary bytes.
 */
export interface AssetUploadState extends AssetFileIdentity {
  expiresAt: string | null;
  id: string | null;
  status: "notAttempted" | "uploading" | "uploaded";
}

type AssetSpec = z.infer<typeof newContentfulAssetSchema>;

/**
 * Builds the source object for a Contentful asset's localized file field.
 *
 * @param spec - Asset specification containing a public URL or staged attachment path.
 * @param upload - Confirmed binary-upload checkpoint required for attachment sources.
 * @returns A URL import or Upload link accepted by the Contentful Management API.
 * @throws {@link Error} When an attachment source lacks a confirmed upload ID.
 */
export const assetFileSource = (spec: AssetSpec, upload?: AssetUploadState) => {
  if ("sourceUrl" in spec) {
    return { upload: spec.sourceUrl };
  }
  if (!upload?.id || upload.status !== "uploaded") {
    throw new Error("The image has no confirmed Contentful upload.");
  }
  return {
    uploadFrom: { sys: { id: upload.id, linkType: "Upload", type: "Link" } },
  };
};

const assertUploadNotExpired = (upload: AssetUploadState) => {
  const expiresAt = upload.expiresAt
    ? Date.parse(upload.expiresAt)
    : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error(
      `Upload ${upload.id} expired before processing. Inspect the reserved asset in Contentful; this operation will not replace the upload or asset.`
    );
  }
};

const verifySavedUpload = async (
  spaceId: string,
  upload: AssetUploadState,
  signal?: AbortSignal
) => {
  assertUploadNotExpired(upload);
  if (!upload.id) {
    throw new Error("The saved Contentful upload ID is missing.");
  }
  try {
    const current = await readContentfulUpload(spaceId, upload.id, signal);
    if (current.expiresAt !== upload.expiresAt) {
      throw new Error("The saved Contentful upload metadata changed.");
    }
  } catch (error) {
    if (error instanceof ContentfulApiError && error.status === 404) {
      throw new Error(
        `Upload ${upload.id} is unavailable or expired. Inspect the reserved asset in Contentful; no replacement will be uploaded.`,
        { cause: error }
      );
    }
    throw error;
  }
};

/**
 * Validates every needed file and existing upload before starting asset writes.
 *
 * @param plan - Durable asset plan whose upload checkpoints may be initialized.
 * @param readFile - Session attachment reader, required only for files not already uploaded.
 * @param record - Persists updated fingerprints after successful preparation.
 * @param signal - Cancellation signal shared by upload reconciliation reads.
 * @returns Binary buffers keyed by asset index and retained only for this invocation.
 * @throws {@link Error} When files changed, uploads expired, or a prior upload outcome remains uncertain.
 */
export const prepareAssetUploads = async (
  plan: ContentfulAssetPlan,
  readFile: ReadAssetFile | undefined,
  record: () => void,
  signal?: AbortSignal
): Promise<Map<number, Uint8Array>> => {
  const files = new Map<number, Uint8Array>();
  for await (const [index, spec] of (plan.input.assets ?? []).entries()) {
    signal?.throwIfAborted();
    const asset = plan.assets[index];
    if (
      "sourceUrl" in spec ||
      ["processed", "publishing", "published"].includes(asset.stage)
    ) {
      continue;
    }
    if (asset.upload?.status === "uploading") {
      throw new Error(
        `Upload outcome for ${spec.key} is uncertain and no upload ID was confirmed. Do not retry or start a replacement operation; inspect Contentful first.`
      );
    }
    if (asset.upload?.status === "uploaded") {
      await verifySavedUpload(
        QUERY_SPACES[plan.input.space],
        asset.upload,
        signal
      );
      continue;
    }
    if (!readFile) {
      throw new Error("A session sandbox is required to upload an attachment.");
    }
    const bytes = await readFile(spec.sourcePath);
    const identity = identifyAssetFile(bytes, spec.contentType);
    if (
      asset.upload &&
      (asset.upload.sha256 !== identity.sha256 ||
        asset.upload.size !== identity.size)
    ) {
      throw new Error(
        `Attachment ${spec.key} changed since this operation started.`
      );
    }
    asset.upload ??= {
      ...identity,
      expiresAt: null,
      id: null,
      status: "notAttempted",
    };
    files.set(index, bytes);
  }
  record();
  return files;
};

/**
 * Checkpoints a non-idempotent binary upload independently from asset creation.
 *
 * @param plan - Durable asset plan to update before and after the upload request.
 * @param index - Asset index whose validated file should be uploaded.
 * @param files - Prepared image bytes keyed by asset index.
 * @param record - Persists the uploading marker and confirmed upload identity.
 * @param signal - Cancellation signal checked before starting the upload.
 * @returns Completes when no binary upload is needed or its identity is confirmed.
 * @throws {@link Error} When bytes are unavailable, the upload expires, or delivery cannot be confirmed.
 */
export const ensureAssetUpload = async (
  plan: ContentfulAssetPlan,
  index: number,
  files: Map<number, Uint8Array>,
  record: () => void,
  signal?: AbortSignal
) => {
  const asset = plan.assets[index];
  const { upload } = asset;
  if (!upload) {
    return;
  }
  if (upload.status === "uploaded") {
    assertUploadNotExpired(upload);
    return;
  }
  const bytes = files.get(index);
  if (!bytes || upload.status !== "notAttempted") {
    throw new Error("No validated file is available for this upload attempt.");
  }
  signal?.throwIfAborted();
  upload.status = "uploading";
  asset.stage = "uploading";
  record();
  let confirmed: ContentfulUpload;
  try {
    confirmed = await createContentfulUpload(
      QUERY_SPACES[plan.input.space],
      bytes,
      signal
    );
  } catch (error) {
    throw new Error(
      `Upload outcome for ${asset.key} is unconfirmed; no upload ID was saved. Inspect Contentful before any retry. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  Object.assign(upload, confirmed, { status: "uploaded" });
  asset.stage = "uploaded";
  record();
  assertUploadNotExpired(upload);
};
