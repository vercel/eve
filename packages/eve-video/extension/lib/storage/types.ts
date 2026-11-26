/** Access visibility for a stored video object. */
export type VideoStorageVisibility = "public" | "private";

/** Input passed to {@link VideoStorage.put} when persisting a video artifact. */
export interface VideoStoragePutInput {
  /** Relative storage object key without a leading slash or traversal segments. */
  readonly key: string;
  /** Raw video bytes to store. */
  readonly data: Uint8Array;
  /** MIME media type of the video payload, such as `video/mp4`. */
  readonly mediaType: string;
  /** Suggested filename for the stored video artifact. */
  readonly filename: string;
  /** Optional string metadata associated with the stored video. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Optional retention time in days for backends that support automatic expiration. */
  readonly ttlDays?: number;
  /** Signal used to cancel the storage write. */
  readonly signal: AbortSignal;
}

/** Location and metadata returned after storing a video artifact. */
export interface StoredVideo {
  /** Canonical key identifying the stored video in the backing storage. */
  readonly key: string;
  /** Public or authenticated URL for accessing the stored video, when available. */
  readonly url?: string;
  /** Direct download URL for the stored video, when provided by the backend. */
  readonly downloadUrl?: string;
  /** Local filesystem path to the stored video, when persisted on disk. */
  readonly path?: string;
  /** MIME media type of the stored video. */
  readonly mediaType: string;
  /** Size of the stored video in bytes. */
  readonly bytes: number;
  /** Access visibility of the stored video, when applicable. */
  readonly visibility?: VideoStorageVisibility;
  /** ISO 8601 timestamp indicating when the stored video expires, when set. */
  readonly expiresAt?: string;
}

/** Input passed to {@link VideoStorage.get} when reading a stored video. */
export interface VideoStorageGetInput {
  /** Storage key of the video to retrieve. */
  readonly key: string;
  /** Signal used to cancel the storage read. */
  readonly signal: AbortSignal;
}

/** Binary payload and metadata returned by {@link VideoStorage.get}. */
export interface StoredVideoContent {
  /** Storage key of the retrieved video. */
  readonly key: string;
  /** Raw bytes of the retrieved video. */
  readonly data: Uint8Array;
  /** MIME media type of the retrieved video. */
  readonly mediaType: string;
  /** Size of the retrieved video in bytes. */
  readonly bytes: number;
}

/** Input passed to {@link VideoStorage.delete} when removing a stored video. */
export interface VideoStorageDeleteInput {
  /** Storage key of the video to delete. */
  readonly key: string;
  /** Signal used to cancel the storage delete. */
  readonly signal: AbortSignal;
}

/** Provider-agnostic storage contract for persisting generated videos. */
export interface VideoStorage {
  /** Stores video bytes and returns metadata describing where the artifact lives. */
  readonly put: (input: VideoStoragePutInput) => Promise<StoredVideo>;
  /** Reads stored video bytes by key, returning `null` when the object does not exist. */
  readonly get?: (input: VideoStorageGetInput) => Promise<StoredVideoContent | null>;
  /** Deletes a stored video by key if it exists. */
  readonly delete?: (input: VideoStorageDeleteInput) => Promise<void>;
}
