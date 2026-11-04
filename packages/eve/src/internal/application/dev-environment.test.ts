import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDevelopmentStateDirectory } from "#internal/application/dev-environment.js";
import { resolveDevelopmentRuntimeArtifactsPointerPath } from "#internal/nitro/dev-runtime-artifacts.js";
import { resolveDevelopmentRuntimeArtifactsSnapshotsDirectory } from "#internal/nitro/dev-runtime-generation-metadata.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";

const appRoot = resolve("/projects/agent");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveDevelopmentStateDirectory", () => {
  it("defaults to the app's .eve directory", () => {
    vi.stubEnv("EVE_DEV_STATE_DIR", "");

    expect(resolveDevelopmentStateDirectory(appRoot)).toBe(join(appRoot, ".eve"));
  });

  it("moves every single-owner dev server path under the override", () => {
    const stateDirectory = join(appRoot, ".eve", "eval-servers", "run-1");
    vi.stubEnv("EVE_DEV", "1");
    vi.stubEnv("EVE_DEV_STATE_DIR", stateDirectory);

    expect(resolveDevelopmentStateDirectory(appRoot)).toBe(stateDirectory);
    expect(resolveDevelopmentRuntimeArtifactsPointerPath(appRoot)).toBe(
      join(stateDirectory, "dev-runtime", "current.json"),
    );
    expect(resolveDevelopmentRuntimeArtifactsSnapshotsDirectory(appRoot)).toBe(
      join(stateDirectory, "dev-runtime", "snapshots"),
    );
    expect(resolveLocalWorkflowWorldDataDirectory(appRoot)).toBe(
      join(stateDirectory, ".workflow-data"),
    );
  });

  it("keeps a production server's Workflow store in .eve when the override leaks in", () => {
    vi.stubEnv("EVE_DEV", "");
    vi.stubEnv("EVE_DEV_STATE_DIR", join(appRoot, ".eve", "eval-servers", "run-1"));

    expect(resolveLocalWorkflowWorldDataDirectory(appRoot)).toBe(
      join(appRoot, ".eve", ".workflow-data"),
    );
  });
});
