/**
 * Blob path prefixes the general-purpose asset tools refuse.
 *
 * @remarks
 * `eve/memory/` is where eve's file memory keeps each writer's preferences when it shares the
 * asset store, and `writer-preferences/` is where earlier versions of this template kept them.
 * The asset tools (`upload_asset`, `list_assets`, `get_asset_info`, `download_asset`,
 * `delete_asset`) treat both as off-limits, so they can't be used as a side channel to read or
 * overwrite another writer's preferences.
 */
const RESERVED_PREFIXES = ["eve/memory/", "writer-preferences/"] as const;

/**
 * Error returned by an asset tool asked to touch a reserved path.
 */
export const RESERVED_PATH_ERROR =
  "That path is reserved for writer memory and isn't available to the asset tools.";

/**
 * Whether a Blob pathname falls under a reserved prefix.
 *
 * @param pathname - A Blob object pathname (no leading slash), e.g. `drafts/post.md`.
 * @returns `true` when the path is reserved.
 */
export const isReservedPath = (pathname: string): boolean =>
  RESERVED_PREFIXES.some((prefix) => pathname.startsWith(prefix));

/** Leading slashes stripped from a URL pathname before the reserved-prefix check. */
const LEADING_SLASHES = /^\/+/;

/**
 * Whether a Blob URL points at a reserved object.
 *
 * @remarks
 * A Blob URL embeds the object pathname as its URL path, so the reserved-prefix check applies
 * to the URL's pathname. Unparseable input is treated as not reserved; the caller's own URL
 * validation handles malformed URLs.
 *
 * @param url - A full Blob URL.
 * @returns `true` when the URL addresses a reserved object.
 */
export const isReservedUrl = (url: string): boolean => {
  try {
    return isReservedPath(new URL(url).pathname.replace(LEADING_SLASHES, ""));
  } catch {
    return false;
  }
};
