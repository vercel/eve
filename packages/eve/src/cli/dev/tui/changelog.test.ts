import { describe, expect, it } from "vitest";

import { formatCurrentChangelog } from "./changelog.js";

describe("formatCurrentChangelog", () => {
  it("formats only the newest release and links to the complete history", () => {
    expect(
      formatCurrentChangelog(`# eve

## 1.2.3

### Minor Changes

- abc1234: Add a thing.

### Patch Changes

- def5678: Fix a thing.

## 1.2.2

### Patch Changes

- older: Don't show this.`),
    ).toBe(
      "eve 1.2.3\n\nMinor Changes\n\n• Add a thing.\n\nPatch Changes\n\n• Fix a thing.\n\nFull changelog: https://eve.dev/changelog",
    );
  });

  it("returns undefined without a release entry", () => {
    expect(formatCurrentChangelog("# eve\n")).toBeUndefined();
  });
});
