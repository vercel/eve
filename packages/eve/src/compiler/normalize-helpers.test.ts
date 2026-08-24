import { describe, expect, it } from "vitest";

import {
  normalizeSelectedSource,
  SOURCE_NORMALIZATION_FAILED_DIAGNOSTIC_CODE,
  SourceNormalizationError,
} from "#compiler/normalize-helpers.js";

describe("normalizeSelectedSource", () => {
  it("attaches stable canonical provenance without inventing a physical path", async () => {
    const error = await normalizeSelectedSource(
      {
        kind: "tool",
        logicalPath: "tools/search.ts",
        nodeId: "__root__",
        sourceId: "application:tools/search.ts",
      },
      () => {
        throw new Error("invalid export");
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SourceNormalizationError);
    expect((error as SourceNormalizationError).diagnostic).toEqual({
      code: SOURCE_NORMALIZATION_FAILED_DIAGNOSTIC_CODE,
      logicalPath: "tools/search.ts",
      message: 'Failed to normalize selected tool source "tools/search.ts": invalid export',
      nodeId: "__root__",
      severity: "error",
      sourceId: "application:tools/search.ts",
    });
  });

  it("preserves an existing source-normalization diagnostic across nested compilation", async () => {
    const source = {
      kind: "agent config",
      logicalPath: "agent.ts",
      nodeId: "__root__",
      sourceId: "application:agent.ts",
    } as const;
    const inner = new SourceNormalizationError(source, new Error("invalid config"));
    const error = await normalizeSelectedSource(source, () => {
      throw inner;
    }).catch((caught: unknown) => caught);

    expect(error).toBe(inner);
  });
});
