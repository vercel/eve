import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArtifactMessageImage,
  MessageResponse,
} from "@web/components/ai-elements/message";

describe("message response rendering", () => {
  it("uses the synchronous renderer for settled text", () => {
    const response = MessageResponse({ children: "Current response" });

    expect(response.props).toMatchObject({
      children: "Current response",
      isAnimating: false,
      mode: "static",
    });
  });

  it("keeps incremental rendering while text is streaming", () => {
    const response = MessageResponse({
      children: "Partial response",
      isAnimating: true,
    });

    expect(response.props).toMatchObject({
      children: "Partial response",
      isAnimating: true,
      mode: "streaming",
    });
  });

  it("renders only authenticated artifact images inline", () => {
    const artifactMarkup = renderToStaticMarkup(
      createElement(ArtifactMessageImage, {
        alt: "Product",
        src: "/artifacts/0d01e667-d128-4bb7-a248-1ae21db72f4f",
      })
    );
    const externalMarkup = renderToStaticMarkup(
      createElement(ArtifactMessageImage, {
        alt: "External product",
        src: "https://example.com/product.png",
      })
    );

    expect(artifactMarkup).toContain("<img");
    expect(artifactMarkup).toContain('loading="lazy"');
    expect(artifactMarkup).toContain("/artifacts/0d01e667");
    expect(externalMarkup).toContain("Image not displayed: External product");
    expect(externalMarkup).not.toContain("https://example.com/product.png");
  });
});
