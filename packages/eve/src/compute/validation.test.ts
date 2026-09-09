import { describe, expect, it } from "vitest";

import { ComputeError } from "#compute/errors.js";
import { parseDeploymentManifest } from "#compute/manifest.js";
import { assertDefinitionId, assertUtcTimestamp, parseCounter } from "#compute/validation.js";

const digest = `sha256:${"a".repeat(64)}` as const;

describe("compute protocol validation", () => {
  it("accepts normalized definition paths and rejects path escapes or URLs", () => {
    expect(() => assertDefinitionId("cells/counter.ts", "definition")).not.toThrow();
    for (const value of ["", "/cells/counter", "cells//counter", "../counter", "https://x"]) {
      expect(() => assertDefinitionId(value, "definition")).toThrowError(ComputeError);
    }
  });

  it("bounds counters and requires explicit timestamp offsets", () => {
    expect(parseCounter("9223372036854775807", "counter")).toBe(9223372036854775807n);
    expect(() => parseCounter("9223372036854775808", "counter")).toThrow();
    expect(() => parseCounter("-1", "counter")).toThrow();
    expect(() => assertUtcTimestamp("2026-09-09T12:00:00Z", "deadline")).not.toThrow();
    expect(() => assertUtcTimestamp("2026-09-09T12:00:00", "deadline")).toThrow();
  });

  it("validates deployment definition ownership fields", () => {
    expect(
      parseDeploymentManifest({
        protocol: 1,
        image: digest,
        artifactManifestHash: digest,
        definitions: [
          {
            id: "cells/counter",
            kind: "cell",
            module: "cells/counter.ts",
            export: "default",
            inputVersion: 1,
            stateVersion: 1,
            outputVersion: null,
            retry: null,
          },
        ],
      }),
    ).toMatchObject({ protocol: 1 });
    expect(() =>
      parseDeploymentManifest({
        protocol: 1,
        image: digest,
        artifactManifestHash: digest,
        definitions: [
          {
            id: "cells/counter",
            kind: "cell",
            module: "../counter.ts",
            export: "default",
            inputVersion: 1,
            stateVersion: 1,
            outputVersion: null,
            retry: null,
          },
        ],
      }),
    ).toThrow(/must not contain empty/u);
  });
});
