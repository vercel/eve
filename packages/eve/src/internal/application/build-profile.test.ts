import { describe, expect, it } from "vitest";

import {
  APPLICATION_BUILD_PROFILE_SCHEMA_VERSION,
  ApplicationBuildProfiler,
  createApplicationBuildProfile,
} from "./build-profile.js";

describe("ApplicationBuildProfiler", () => {
  it("records rounded phase timings and one total duration", async () => {
    let now = 100;
    const profiler = new ApplicationBuildProfiler({ now: () => now });

    await profiler.measure("host.prepare", async () => {
      now = 123.456;
    });
    await profiler.measure("nitro.all.bundle", () => {
      now = 200;
    });

    expect(profiler.finish()).toEqual({
      durationMs: 100,
      phases: [
        { durationMs: 23.5, name: "host.prepare" },
        { durationMs: 76.5, name: "nitro.all.bundle" },
      ],
    });
  });

  it("keeps failed phase timing for callers that handle an error", async () => {
    let now = 10;
    const profiler = new ApplicationBuildProfiler({ now: () => now });

    await expect(
      profiler.measure("nitro.all.bundle", () => {
        now = 25;
        throw new Error("bundle failed");
      }),
    ).rejects.toThrow("bundle failed");

    expect(profiler.finish()).toEqual({
      durationMs: 15,
      phases: [{ durationMs: 15, name: "nitro.all.bundle" }],
    });
  });
});

describe("createApplicationBuildProfile", () => {
  it("creates a versioned, machine-readable profile", () => {
    expect(
      createApplicationBuildProfile({
        output: {
          files: 3,
          functionBundles: [
            { files: 2, gzipBytes: 18, path: "functions/eve/__server.func", rawBytes: 42 },
          ],
          gzipBytes: 27,
          rawBytes: 64,
        },
        target: "vercel",
        timing: {
          durationMs: 125.4,
          phases: [{ durationMs: 100, name: "nitro.flow.bundle" }],
        },
      }),
    ).toEqual({
      durationMs: 125.4,
      kind: "eve-build-profile",
      output: {
        files: 3,
        functionBundles: [
          { files: 2, gzipBytes: 18, path: "functions/eve/__server.func", rawBytes: 42 },
        ],
        gzipBytes: 27,
        rawBytes: 64,
      },
      phases: [{ durationMs: 100, name: "nitro.flow.bundle" }],
      schemaVersion: APPLICATION_BUILD_PROFILE_SCHEMA_VERSION,
      target: "vercel",
    });
  });
});
