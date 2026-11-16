import { describe, expect, it } from "vitest";
import {
  browserImageArtifactReferenceSchema,
  browserImageArtifactUrl,
  isBrowserImageArtifactUrl,
  sniffBrowserImageMediaType,
} from "@shared/browser/artifact";
import {
  taskCompletionOutputSchema,
  taskCompletionSchema,
} from "@agent/subagents/browser-agent/lib/completion";
import {
  extractImageArtifactMarkdownReferences,
  stripImageArtifactMarkdownReferences,
} from "@agent/lib/linq-image-artifact/markdown";

const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";

describe("browser image contracts", () => {
  it("binds artifact URLs to their ids", () => {
    const artifact = browserImageArtifactReferenceSchema.parse({
      byteSize: 4,
      filename: "product.png",
      id: artifactId,
      label: "Product image",
      mediaType: "image/png",
      url: browserImageArtifactUrl(artifactId),
    });

    expect(artifact.url).toBe(`/artifacts/${artifactId}`);
    expect(isBrowserImageArtifactUrl(artifact.url)).toBe(true);
    expect(isBrowserImageArtifactUrl("https://example.com/image.png")).toBe(
      false
    );
    expect(
      browserImageArtifactReferenceSchema.safeParse({
        ...artifact,
        url: "/artifacts/206c3a7e-c0b8-4317-9e34-552cff646673",
      }).success
    ).toBe(false);
  });

  it("extracts and strips only exact artifact image markdown", () => {
    const artifact = browserImageArtifactReferenceSchema.parse({
      byteSize: 4,
      filename: "product.png",
      id: artifactId,
      label: "Product [front]",
      mediaType: "image/png",
      url: browserImageArtifactUrl(artifactId),
    });
    const markdown = `![Product](${artifact.url})`;
    const message = `Here it is.\n\n${markdown}\n\n${markdown}`;

    expect(extractImageArtifactMarkdownReferences(message)).toEqual([
      expect.objectContaining({ id: artifactId, url: artifact.url }),
    ]);
    expect(stripImageArtifactMarkdownReferences(message)).toBe("Here it is.");
    expect(
      stripImageArtifactMarkdownReferences(
        "![external](https://example.com/image.png)"
      )
    ).toBe("![external](https://example.com/image.png)");
  });

  it.each([
    [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "image/png",
    ],
    [new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"],
    [new TextEncoder().encode("GIF89a"), "image/gif"],
    [new TextEncoder().encode("RIFF0000WEBP"), "image/webp"],
    [new TextEncoder().encode("<svg></svg>"), undefined],
  ])("sniffs supported image bytes", (bytes, expected) => {
    expect(sniffBrowserImageMediaType(bytes)).toBe(expected);
  });

  it("defaults historical worker results to no images and caps new results", () => {
    expect(
      taskCompletionOutputSchema.parse({ message: "Done", status: "success" })
    ).toEqual({ images: [], message: "Done", status: "success" });
    expect(
      taskCompletionSchema.safeParse({ message: "Done", status: "success" })
        .success
    ).toBe(false);
    const image = {
      byteSize: 4,
      filename: "product.png",
      id: artifactId,
      label: "Product",
      mediaType: "image/png" as const,
      url: browserImageArtifactUrl(artifactId),
    };
    expect(
      taskCompletionSchema.safeParse({
        images: Array.from({ length: 5 }, () => image),
        message: "Done",
        status: "success",
      }).success
    ).toBe(false);
  });
});
