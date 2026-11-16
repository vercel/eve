import { z } from "zod";

export const maximumBrowserImageBytes = 8 * 1024 * 1024;

export const browserImageMediaTypeSchema = z.enum([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const browserImageSourceKinds = [
  "element",
  "full_page",
  "image_resource",
  "viewport",
] as const;

export const browserImageSourceKindSchema = z.enum(browserImageSourceKinds);

export const browserImageArtifactReferenceSchema = z
  .object({
    byteSize: z.number().int().positive().max(maximumBrowserImageBytes),
    filename: z.string().trim().min(1).max(180),
    id: z.uuid(),
    label: z.string().trim().min(1).max(200),
    mediaType: browserImageMediaTypeSchema,
    url: z.string(),
  })
  .refine((artifact) => artifact.url === browserImageArtifactUrl(artifact.id), {
    message: "Artifact URL must match its id.",
    path: ["url"],
  });

export type BrowserImageArtifactReference = z.infer<
  typeof browserImageArtifactReferenceSchema
>;

export function browserImageArtifactUrl(id: string) {
  return `/artifacts/${encodeURIComponent(z.uuid().parse(id))}`;
}

export function isBrowserImageArtifactUrl(value: string) {
  const parsed = /^\/artifacts\/([^/]+)$/u.exec(value);
  if (!parsed?.[1]) return false;
  return z.uuid().safeParse(decodeURIComponent(parsed[1])).success;
}

export function sniffBrowserImageMediaType(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png" as const;
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg" as const;
  }
  if (bytes.length >= 6) {
    const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif" as const;
    }
  }
  if (
    bytes.length >= 12 &&
    new TextDecoder("ascii").decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder("ascii").decode(bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp" as const;
  }
  return undefined;
}
