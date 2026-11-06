import { describe, expect, it } from "vitest";

import {
  fingerprintVercelTeam,
  hashEveTelemetryProject,
  resolveEveTelemetryInternal,
  resolveEveTelemetryProjectId,
} from "#cli/telemetry/identity.js";

const identity = { installationId: "installation_123", projectSalt: "project_salt_123" };

describe("eve CLI telemetry identity", () => {
  it("uses the Git remote before environment and working-directory fallbacks", async () => {
    const projectId = await resolveEveTelemetryProjectId({
      cwd: "/project",
      repositoryUrl: "https://example.com/environment.git",
      identity,
      getGitRemote: async () => "git@example.com:owner/project.git",
    });

    expect(projectId).toBe(hashEveTelemetryProject(identity, "git@example.com:owner/project.git"));
    expect(projectId).not.toBe("git@example.com:owner/project.git");
  });

  it("uses the repository environment variable before the working directory", async () => {
    const projectId = await resolveEveTelemetryProjectId({
      cwd: "/project",
      repositoryUrl: "https://example.com/environment.git",
      identity,
      getGitRemote: async () => undefined,
    });

    expect(projectId).toBe(
      hashEveTelemetryProject(identity, "https://example.com/environment.git"),
    );
  });

  it("uses the working directory when no repository identifier is available", async () => {
    const projectId = await resolveEveTelemetryProjectId({
      cwd: "/project",
      identity,
      getGitRemote: async () => undefined,
    });

    expect(projectId).toBe(hashEveTelemetryProject(identity, "/project"));
  });

  it("uses different hashes for different salts", () => {
    expect(hashEveTelemetryProject(identity, "project")).not.toBe(
      hashEveTelemetryProject({ ...identity, projectSalt: "other_salt" }, "project"),
    );
  });
});

describe("eve CLI telemetry internal flag", () => {
  const fingerprints = new Set([fingerprintVercelTeam("team_internal")]);

  it("matches the selected team by fingerprint, not by raw ID", async () => {
    expect(fingerprintVercelTeam("team_internal")).not.toContain("team_internal");
    await expect(
      resolveEveTelemetryInternal({ fingerprints, readTeam: async () => "team_internal" }),
    ).resolves.toBe(true);
  });

  it("reports false for another team or no selected team", async () => {
    await expect(
      resolveEveTelemetryInternal({ fingerprints, readTeam: async () => "team_other" }),
    ).resolves.toBe(false);
    await expect(
      resolveEveTelemetryInternal({ fingerprints, readTeam: async () => undefined }),
    ).resolves.toBe(false);
  });

  it("skips the Vercel CLI config when there are no fingerprints", async () => {
    let read = false;
    await expect(
      resolveEveTelemetryInternal({
        fingerprints: new Set(),
        readTeam: async () => {
          read = true;
          return "team_internal";
        },
      }),
    ).resolves.toBeUndefined();
    expect(read).toBe(false);
  });
});
