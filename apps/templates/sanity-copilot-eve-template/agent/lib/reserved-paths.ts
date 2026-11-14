/**
 * Blob path prefixes the general-purpose asset tools refuse.
 *
 * @remarks
 * `eve/memory/` is where eve's file memory keeps each user's preferences in the project's Blob
 * store. Nothing in the agent reads or writes `user-preferences/`, but an older store may still
 * hold per-user preference files there, and the asset tools must not expose them.
 * The asset tools (`upload_asset`, `list_assets`, `get_asset_info`, `download_asset`,
 * `delete_asset`) treat both as off-limits, so they can't be used as a side channel to read or
 * overwrite another user's preferences.
 */
const RESERVED_PREFIXES = ["eve/memory/", "user-preferences/"] as const;

/**
 * Error returned by an asset tool asked to touch a reserved path.
 */
export const RESERVED_PATH_ERROR =
  "That path is reserved for user preferences and isn't available to the asset tools.";

/**
 * Whether a Blob pathname falls under a reserved prefix.
 *
 * @remarks
 * Use the same decoded, slash-stripped representation for storage paths and URL paths.
 * Reject nested escapes, traversal, URL delimiters, backslashes, and control characters:
 * their interpretation can differ between the storage API and an HTTP URL.
 *
 * @param pathname - A Blob object pathname, e.g. `drafts/post.md`.
 * @returns `true` when the path is reserved, malformed, or ambiguous.
 */
export const isReservedPath = (pathname: string): boolean => {
  try {
    const decoded = decodeURIComponent(pathname);
    const normalized = decoded.replace(LEADING_SLASHES, "");
    return (
      AMBIGUOUS_PATH.test(normalized) ||
      Array.from(normalized).some((char) => {
        const code = char.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    );
  } catch {
    return true;
  }
};

const LEADING_SLASHES = /^\/+/;
const AMBIGUOUS_PATH = /[%\\?#]|(?:^|\/)\.{1,2}(?:\/|$)/;

/**
 * Whether a Blob URL points at a reserved object.
 *
 * @remarks
 * A Blob URL embeds the object pathname as its URL path. The storage-path guard decodes it
 * exactly once and refuses malformed or ambiguous encodings rather than guessing a namespace.
 *
 * @param url - A full Blob URL.
 * @returns `true` when the URL addresses a reserved object or cannot be checked safely.
 */
export const isReservedUrl = (url: string): boolean => {
  try {
    return isReservedPath(new URL(url).pathname);
  } catch {
    return true;
  }
};
