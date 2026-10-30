import { describe, expect, it } from "vitest";

import { estimateMediaTokens } from "#internal/attachments/media-metadata.js";

describe("estimateMediaTokens", () => {
  it("counts image patches up to the largest provider cap", () => {
    expect(
      estimateMediaTokens({ height: 1000, mediaType: "image/png", size: 1, width: 1000 }),
    ).toBe(1296);
    expect(
      estimateMediaTokens({ height: 3000, mediaType: "image/png", size: 1, width: 4000 }),
    ).toBe(4784);
    expect(estimateMediaTokens({ mediaType: "image/png", size: 1 })).toBe(4784);
  });

  it("counts PDFs per page and other files by their base64 size", () => {
    expect(estimateMediaTokens({ mediaType: "application/pdf", pages: 3, size: 9 })).toBe(9000);
    expect(estimateMediaTokens({ mediaType: "application/octet-stream", size: 9000 })).toBe(3000);
  });
});
