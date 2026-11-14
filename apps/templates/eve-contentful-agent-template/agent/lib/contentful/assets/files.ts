/* Image-source validation shared by the sandbox adapter and asset creation. */
import { createHash } from "node:crypto";
import pathUtils from "node:path";

/* Keep per-call image buffering bounded to at most five 20 MiB files. */
export const MAX_ASSET_FILE_BYTES = 20 * 1024 * 1024;

const hasInvalidPathCharacters = (path: string) =>
  [...path].some(
    (character) => (character.codePointAt(0) ?? 0) < 32 || character === "\\"
  );

/**
 * Checks that a normalized file path stays inside the session's attachment directory.
 *
 * @param path - Absolute sandbox path supplied for an image attachment.
 * @returns Whether the path has the required prefix and excludes traversal, controls, and directory-only paths.
 * @remarks This lexical check does not resolve symlinks; sandboxAssetReader performs that check.
 */
export const isAssetFilePath = (path: string): boolean =>
  path.startsWith("/workspace/.eve/attachments/") &&
  !hasInvalidPathCharacters(path) &&
  pathUtils.posix.normalize(path) === path &&
  !path.endsWith("/");

/* Injected by the tool adapter; image bytes never enter durable JSON state. */
/**
 * Reads attachment bytes from the session sandbox without persisting them in operation state.
 *
 * @param path - Validated absolute attachment path in the sandbox.
 * @returns The file's binary contents for bounded validation and upload.
 */
export type ReadAssetFile = (path: string) => Promise<Uint8Array>;

/* Persisted identity used to reject changed files before a later upload attempt. */
/**
 * Persisted byte count and SHA-256 fingerprint used to reject changed files during recovery.
 */
export interface AssetFileIdentity {
  sha256: string;
  size: number;
}

const imageContentType = (bytes: Buffer): string | null => {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) {
    return "image/jpeg";
  }
  const signature = bytes.toString("ascii", 0, 6);
  if (signature === "GIF87a" || signature === "GIF89a") {
    return "image/gif";
  }
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.toString("ascii", 4, 8) === "ftyp" &&
    ["avif", "avis"].includes(bytes.toString("ascii", 8, 12))
  ) {
    return "image/avif";
  }
  return null;
};

/**
 * Validates image size and signature, then fingerprints the exact upload bytes.
 *
 * @param bytes - Binary contents read from a session attachment.
 * @param contentType - Declared PNG, JPEG, GIF, WebP, or AVIF media type to verify.
 * @returns The byte count and SHA-256 digest saved with recovery state.
 * @throws {@link Error} When the file is empty, exceeds 20 MiB, or has a mismatched image signature.
 */
export const identifyAssetFile = (
  bytes: Uint8Array,
  contentType: string
): AssetFileIdentity => {
  if (!bytes.byteLength || bytes.byteLength > MAX_ASSET_FILE_BYTES) {
    throw new Error("Image files must be non-empty and at most 20 MiB.");
  }
  if (imageContentType(Buffer.from(bytes)) !== contentType) {
    throw new Error(
      "Image bytes must match contentType: PNG, JPEG, GIF, WebP, or AVIF."
    );
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
};
