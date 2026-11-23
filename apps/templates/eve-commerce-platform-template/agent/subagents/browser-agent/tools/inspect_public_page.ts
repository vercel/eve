import { createHash } from "node:crypto";
import { del, put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "../lib/access";
import { capturePublicResearchPreview } from "../lib/research-screenshot";
import {
  browserImageArtifactReferenceSchema,
  maximumBrowserImageBytes,
  sniffBrowserImageMediaType,
} from "@/lib/browser/artifact";
import {
  finalizeBrowserImageArtifact,
  reserveBrowserImageArtifact,
  type BrowserImageArtifactReservation,
} from "@/lib/browser/images";
import { readPublicResearchImage, readPublicResearchPage } from "@/lib/browser/public-preview";
import { env } from "@/lib/environment/env";
import type { AccessScope } from "@/lib/auth/scope";

export default defineTool({
  description:
    "Read an anonymous public HTTPS page without signing in, running site scripts, clicking, or submitting forms. Optionally attach its declared primary image or a screenshot of a safe text preview. A preview is not a screenshot of the original page.",
  inputSchema: z.strictObject({
    url: z.string().trim().min(1).max(2_048),
    image: z.enum(["preview", "product_image"]).optional(),
  }),
  outputSchema: z.object({
    url: z.url(),
    title: z.string(),
    text: z.string(),
    links: z.array(z.url()),
    image: browserImageArtifactReferenceSchema.optional(),
    imageUnavailable: z.literal(true).optional(),
  }),
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    const parent = context.session.parent;
    if (!parent) throw new Error("Page research requires a delegated worker.");
    const signal = context.abortSignal;
    const page = await readPublicResearchPage(
      input.url,
      AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    );
    const { url, text, title, links } = page;
    const research = { url, text, title, links };
    if (!input.image) return research;
    if (
      (!env.BLOB_STORE_ID && !env.BLOB_READ_WRITE_TOKEN) ||
      (input.image === "product_image" && !page.imageUrl)
    )
      return { ...research, imageUnavailable: true };

    const sourceKind = input.image === "preview" ? "viewport" : "image_resource";
    const label = input.image === "preview" ? `Public page preview: ${title}`.slice(0, 200) : title;
    const reserved = await reserveBrowserImageArtifact(scope, {
      idempotencyKey: `browser-image:${context.session.id}:${context.callId}`,
      label,
      rootSessionId: parent.rootSessionId,
      sourceKind,
      workerSessionId: context.session.id,
    });
    if (reserved.status === "ready") return { ...research, image: reserved.image };
    try {
      const bytes =
        input.image === "preview"
          ? await capturePublicResearchPreview(page, signal)
          : await readPublicResearchImage(
              page.imageUrl ?? "",
              AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
            );
      return {
        ...research,
        image: await storeImage(scope, reserved.reservation, { bytes, sourceKind, label }, signal),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return { ...research, imageUnavailable: true };
    }
  },
});

async function storeImage(
  scope: AccessScope,
  reservation: BrowserImageArtifactReservation,
  input: { readonly bytes: Uint8Array; readonly sourceKind: string; readonly label: string },
  signal: AbortSignal,
) {
  const mediaType = sniffBrowserImageMediaType(input.bytes);
  if (!mediaType) throw new Error("The resource is not a supported image.");
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  const storagePathname = `${reservation.storagePathname}/${contentHash}`;
  const extension = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  }[mediaType];
  const name = input.label
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} _-]+/gu, "_")
    .trim()
    .slice(0, 120);
  await put(storagePathname, Buffer.from(input.bytes), {
    access: "private",
    abortSignal: signal,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: mediaType,
    maximumSizeInBytes: maximumBrowserImageBytes,
  });
  try {
    const finalized = await finalizeBrowserImageArtifact(scope, reservation, {
      byteSize: input.bytes.byteLength,
      contentHash,
      filename: `${name || "public-page"}.${extension}`,
      mediaType,
      sourceKind: input.sourceKind,
      storagePathname,
    });
    if (finalized.storagePathname !== storagePathname)
      await del(storagePathname).catch(() => undefined);
    return finalized.image;
  } catch (error) {
    await del(storagePathname).catch(() => undefined);
    throw error;
  }
}
