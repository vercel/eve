import { describe, expect, it } from "vitest";

import { hashEveTelemetryProject, resolveEveTelemetryProjectId } from "#cli/telemetry/identity.js";

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
