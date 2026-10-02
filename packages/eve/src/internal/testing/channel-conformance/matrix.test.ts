import { expect, it } from "vitest";

import { renderHitlConformanceMatrix } from "#internal/testing/channel-conformance/conformance.js";

it("MATRIX.md shows the conformance table", async () => {
  await expect(renderHitlConformanceMatrix()).toMatchFileSnapshot("./MATRIX.md");
});
