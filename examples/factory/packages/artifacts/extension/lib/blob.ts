import { BlobNotFoundError, get, head, put } from "@vercel/blob";

/**
 * Blob access scoped to the artifacts namespace.
 *
 * @remarks
 * The extension is self-contained: it carries its own Blob helpers rather
 * than importing the consuming workspace's `lib/blob.ts`, whose reserved
 * namespace registry also guards the factory brain and user preferences —
 * documents this extension must never be able to reach. Everything here can
 * only address keys under {@link ARTIFACTS_PREFIX}; `artifactKey` in
 * `config.ts` validates model-supplied ids before they become keys.
 *
 * Authorization resolves from the ambient Vercel OIDC credentials, as in
 * the template.
 */

/**
 * Reserved key prefix for handoff artifacts.
 */
export const ARTIFACTS_PREFIX = "artifacts/";

/**
 * Write a Markdown document under the artifacts prefix.
 *
 * @param key - Blob key; must be inside {@link ARTIFACTS_PREFIX}.
 * @param content - Markdown body.
 * @param options - `allowOverwrite: false` fails when the key already exists.
 */
export async function writeDocument(
  key: string,
  content: string,
  options: { allowOverwrite: boolean },
): Promise<void> {
  if (!key.startsWith(ARTIFACTS_PREFIX)) {
    throw new Error(`Key "${key}" is outside the artifacts namespace.`);
  }
  if (!options.allowOverwrite) {
    const existing = await head(key).catch((error: unknown) => {
      if (error instanceof BlobNotFoundError) {
        return null;
      }
      throw error;
    });
    if (existing !== null) {
      throw new Error(`Artifact "${key}" already exists.`);
    }
  }
  await put(key, content, {
    access: "public",
    addRandomSuffix: false,
    contentType: "text/markdown",
  });
}

/**
 * Read a Markdown document back from the artifacts prefix.
 *
 * @param key - Blob key; must be inside {@link ARTIFACTS_PREFIX}.
 * @returns The document and its upload time, or `found: false`.
 */
export async function readDocument(
  key: string,
): Promise<{ found: false } | { content: string; found: true; uploadedAt: string }> {
  if (!key.startsWith(ARTIFACTS_PREFIX)) {
    return { found: false };
  }
  try {
    const blob = await get(key);
    if (blob === null) {
      return { found: false };
    }
    const response = await fetch(blob.url);
    if (!response.ok) {
      return { found: false };
    }
    return {
      content: await response.text(),
      found: true,
      uploadedAt: blob.uploadedAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return { found: false };
    }
    throw error;
  }
}
