import { createHash } from "node:crypto";
import { get } from "@vercel/blob";
import type { AccessScope } from "@shared/identity/access-scope";
import { readReadyBrowserImageArtifact } from "@db/services/browser-images";
import { maximumBrowserImageBytes } from "@shared/browser/artifact";
import { env } from "@shared/environment";
import { maximumWorkerCompletionImages } from "@agent/subagents/browser-agent/lib/completion";
import {
  extractImageArtifactMarkdownReferences,
  stripImageArtifactMarkdownReferences,
} from "./markdown";

interface LinqImageArtifactFile {
  readonly data: Buffer;
  readonly filename: string;
  readonly mimeType: string;
}

export async function prepareLinqImageArtifactDelivery(
  message: string,
  input: {
    readonly rootSessionId: string;
    readonly scope: AccessScope;
    readonly signal?: AbortSignal;
  }
) {
  const references = extractImageArtifactMarkdownReferences(message);
  if (references.length === 0) {
    return { failedArtifactIds: [], files: [], text: message };
  }

  const selected = references.slice(0, maximumWorkerCompletionImages);
  const loaded = await Promise.all(
    selected.map(async (reference) => ({
      image: await readLinqImageArtifact(input.scope, reference.id, {
        rootSessionId: input.rootSessionId,
        signal: input.signal,
      }).catch(() => undefined),
      reference,
    }))
  );
  const failedArtifactIds = [
    ...loaded
      .filter((item) => item.image === undefined)
      .map((item) => item.reference.id),
    ...references
      .slice(maximumWorkerCompletionImages)
      .map((reference) => reference.id),
  ];
  const files = loaded.flatMap(({ image }) =>
    image
      ? [
          {
            data: Buffer.from(image.bytes),
            filename: image.filename,
            mimeType: image.mediaType,
          } satisfies LinqImageArtifactFile,
        ]
      : []
  );

  return {
    failedArtifactIds,
    files,
    text: stripImageArtifactMarkdownReferences(message),
  };
}

async function readLinqImageArtifact(
  scope: AccessScope,
  artifactId: string,
  options: { readonly rootSessionId: string; readonly signal?: AbortSignal }
) {
  const artifact = await readReadyBrowserImageArtifact(scope, artifactId, {
    rootSessionId: options.rootSessionId,
  });
  if (
    !artifact?.byteSize ||
    !artifact.contentHash ||
    !artifact.filename ||
    !artifact.mediaType
  )
    return undefined;
  if (!env.BLOB_STORE_ID && !env.BLOB_READ_WRITE_TOKEN) return undefined;
  const result = await get(artifact.storagePathname, {
    access: "private",
    abortSignal: options.signal,
  });
  if (result?.statusCode !== 200) return undefined;
  if (
    result.blob.size !== artifact.byteSize ||
    result.blob.contentType !== artifact.mediaType
  )
    return undefined;
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    /* oxlint-disable eslint/no-await-in-loop -- Blob response chunks form an ordered stream. */
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBrowserImageBytes) return undefined;
      chunks.push(value);
    }
    /* oxlint-enable eslint/no-await-in-loop */
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.contentHash)
    return undefined;
  return {
    bytes,
    filename: artifact.filename,
    id: artifact.id,
    mediaType: artifact.mediaType,
  };
}
