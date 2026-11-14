/* Contentful binary Upload API. No implicit retries or caller-selected hosts. */
import { z } from "zod";

import { ContentfulApiError } from "../api";
import { CONTENTFUL_ID, UPLOAD_HOST } from "../model";

const uploadSchema = z.object({
  sys: z.object({
    expiresAt: z.iso.datetime({ offset: true }),
    id: z.string().regex(CONTENTFUL_ID),
    space: z.object({ sys: z.object({ id: z.string() }) }),
    type: z.literal("Upload"),
  }),
});

/* Confirmed upload identity and expiry; no file bytes are persisted. */
/**
 * Confirmed Contentful upload identity and expiration timestamp, excluding binary contents.
 */
export interface ContentfulUpload {
  expiresAt: string;
  id: string;
}

const requestUpload = async (
  spaceId: string,
  uploadId: string | null,
  bytes: Uint8Array | null,
  signal?: AbortSignal
): Promise<ContentfulUpload> => {
  const token = process.env.CONTENTFUL_MANAGEMENT_TOKEN;
  if (!token) {
    throw new Error("CONTENTFUL_MANAGEMENT_TOKEN is not set.");
  }
  const path = `/spaces/${encodeURIComponent(spaceId)}/uploads${
    uploadId === null ? "" : `/${encodeURIComponent(uploadId)}`
  }`;
  const response = await fetch(new URL(path, UPLOAD_HOST), {
    ...(!(bytes === null) && { body: Buffer.from(bytes) }),
    headers: {
      "Content-Type": "application/octet-stream",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    method: bytes === null ? "GET" : "POST",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new ContentfulApiError(
      response.status,
      `Contentful Upload API returned ${response.status}. No automatic retry was made.`
    );
  }
  const { sys } = uploadSchema.parse(await response.json());
  if (
    sys.space.sys.id !== spaceId ||
    (uploadId !== null && sys.id !== uploadId)
  ) {
    throw new Error(
      "Contentful returned an upload for an unexpected space or ID."
    );
  }
  return { expiresAt: sys.expiresAt, id: sys.id };
};

/**
 * Uploads one validated image without retrying the non-idempotent POST.
 *
 * @param spaceId - Raw configured Contentful space ID owning the upload.
 * @param bytes - Validated image bytes to send as an octet-stream body.
 * @param signal - Cancellation signal for the upload request.
 * @returns The upload ID and expiration timestamp after verifying its space identity.
 * @remarks A failed response can still represent an accepted upload; callers must checkpoint uncertainty.
 */
export const createContentfulUpload = (
  spaceId: string,
  bytes: Uint8Array,
  signal?: AbortSignal
) => requestUpload(spaceId, null, bytes, signal);

/**
 * Reads an existing upload to reconcile its identity and expiration during recovery.
 *
 * @param spaceId - Raw Contentful space ID that must own the upload.
 * @param uploadId - Previously confirmed upload ID to read.
 * @param signal - Cancellation signal for the metadata request.
 * @returns Verified upload identity and expiration metadata.
 */
export const readContentfulUpload = (
  spaceId: string,
  uploadId: string,
  signal?: AbortSignal
) => requestUpload(spaceId, uploadId, null, signal);
