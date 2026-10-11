import { expect, it } from "vitest";

import { renderConformanceMatrix } from "#internal/testing/channel-conformance/conformance.js";

it("MATRIX.md shows the conformance table", async () => {
  await expect(renderConformanceMatrix()).toMatchFileSnapshot("./MATRIX.md");
});
