/**
 * Blob namespace layout and the reserved-path guards that protect it.
 *
 * @remarks
 * Everything the team stores lives in one Blob store, so the path layout is a shared concern
 * rather than a per-feature one. This module owns that layout: the reserved prefixes, what each is
 * for, and which tool is allowed to write it. The general-purpose asset tools consult
 * {@link reservedNamespaceForPath} and {@link reservedNamespaceForUrl} before acting, so a model
 * can't reach a managed document through a generic file operation and overwrite the team's
 * positioning or another person's preferences.
 *
 * Feature modules import their prefix from here rather than declaring their own. The dependency
 * points toward storage on purpose: adding a namespace should be a single edit in this file, and
 * the guards can only be complete if one module sees every prefix.
 *
 * @packageDocumentation
 */

/**
 * Host suffix that every Vercel Blob URL ends with.
 *
 * @remarks
 * Tools that fetch a model-supplied URL check it against this suffix. Without that check, a tool
 * taking a URL is an SSRF primitive: the model could point it at an internal address or a
 * third-party host and read the response back.
 */
export const BLOB_HOST_SUFFIX = ".blob.vercel-storage.com";

/**
 * Maximum length of an asset's content, in characters.
 *
 * @remarks
 * Bounds what one upload call can carry. Binary content arrives base64-encoded, so this allows a
 * file of roughly 4.5 MB.
 *
 * @defaultValue 6_000_000
 */
export const MAX_ASSET_CONTENT_LENGTH = 6_000_000;

/**
 * Maximum length of a Blob pathname or list prefix, in characters.
 *
 * @defaultValue 950
 */
export const MAX_PATHNAME_LENGTH = 950;

/**
 * Maximum length of a MIME type, in characters.
 *
 * @defaultValue 255
 */
export const MAX_CONTENT_TYPE_LENGTH = 255;

/**
 * A Blob path prefix that the generic asset tools must not touch.
 *
 * @remarks
 * `writeTool` and `readTool` name the tools that own the namespace, so a guard can tell the model
 * where to go instead of only refusing. Both are optional, because a namespace eve manages itself
 * has no tool to redirect to.
 */
interface ReservedNamespace {
  /** Human-readable description of what the namespace holds. */
  readonly label: string;
  /** Tool that reads this namespace, when one exists. */
  readonly readTool?: string;
  /** Tool that owns writes to this namespace, when one exists. */
  readonly writeTool?: string;
}

/** Blob path prefix holding the team's shared brand context document. */
export const BRAND_CONTEXT_PREFIX = "brand-context/";

/**
 * Blob path prefix where eve's file memory keeps each person's preferences.
 *
 * @remarks
 * File memory shares the team's store, so its prefix is reserved here like any other managed
 * document. The model edits memory through the `preferences__save_memory` and
 * `preferences__remove_memory` tools eve provides, never through a path.
 */
export const MEMORY_PREFIX = "eve/memory/";

/**
 * Blob path prefix that held per-user preference files before the move to file memory.
 *
 * @remarks
 * Still reserved, so files left behind on an existing deployment can't be read or overwritten
 * through the asset tools.
 */
export const LEGACY_USER_PREFERENCES_PREFIX = "user-preferences/";

/** Blob path prefix holding handoff artifacts passed between agents. */
export const ARTIFACTS_PREFIX = "artifacts/";

/**
 * Every reserved prefix, keyed by the prefix itself.
 *
 * @remarks
 * Add a namespace here and every asset tool starts guarding it, with no change at the call sites.
 */
const RESERVED_NAMESPACES: Readonly<Record<string, ReservedNamespace>> = {
  [BRAND_CONTEXT_PREFIX]: {
    label: "the team's brand context",
    readTool: "get_brand_context",
    writeTool: "save_brand_context",
  },
  [MEMORY_PREFIX]: {
    label: "saved preferences",
  },
  [LEGACY_USER_PREFERENCES_PREFIX]: {
    label: "saved preferences",
  },
  [ARTIFACTS_PREFIX]: {
    label: "handoff artifacts",
    readTool: "read_artifact",
    writeTool: "save_artifact",
  },
};

/** Leading slashes stripped from a pathname or URL path before the reserved-prefix check. */
const LEADING_SLASHES = /^\/+/;

/**
 * Find the reserved namespace a Blob pathname falls under, if any.
 *
 * @remarks
 * Leading slashes are stripped first because `@vercel/blob`'s `put` normalizes a pathname by
 * dropping them, so a caller-supplied `/brand-context/brand.md` would land inside the reserved
 * namespace unless the guard sees the normalized form.
 *
 * @param pathname - A Blob object pathname, e.g. `drafts/post.md`.
 * @returns The matching namespace, or `null` when the path is a normal asset.
 */
export const reservedNamespaceForPath = (
  pathname: string
): ReservedNamespace | null => {
  const normalized = pathname.replace(LEADING_SLASHES, "");
  for (const [prefix, namespace] of Object.entries(RESERVED_NAMESPACES)) {
    if (normalized.startsWith(prefix)) {
      return namespace;
    }
  }
  return null;
};

/**
 * Find the reserved namespace a Blob URL points at, if any.
 *
 * @remarks
 * Blob resolves URL-encoded pathnames. Decode before checking reserved prefixes, and
 * reject malformed escapes rather than allowing an ambiguous path through.
 *
 * @param url - A full Blob URL.
 * @returns The matching namespace, or `null` when the URL addresses a normal asset.
 */
export const reservedNamespaceForUrl = (
  url: string
): ReservedNamespace | null => {
  try {
    return reservedNamespaceForPath(decodeURIComponent(new URL(url).pathname));
  } catch {
    return { label: "an invalid or ambiguous Blob path" };
  }
};

/**
 * Build the refusal message for a write blocked by a reserved namespace.
 *
 * @param namespace - The namespace the path or URL fell under.
 * @returns A message naming the owning tool when there is one, for the model to act on.
 */
export const reservedWriteMessage = (namespace: ReservedNamespace): string =>
  namespace.writeTool
    ? `That path is reserved for ${namespace.label}: use ${namespace.writeTool} instead.`
    : `That path is reserved for ${namespace.label}.`;

/**
 * Build the refusal message for a read blocked by a reserved namespace.
 *
 * @param namespace - The namespace the path or URL fell under.
 * @returns A message naming the owning read tool when there is one.
 */
export const reservedReadMessage = (namespace: ReservedNamespace): string =>
  namespace.readTool
    ? `That path holds ${namespace.label}: use ${namespace.readTool} instead.`
    : `That path is reserved for ${namespace.label}.`;
