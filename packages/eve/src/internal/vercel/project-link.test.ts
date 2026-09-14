import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readVercelProjectLink } from "./project-link.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const mockedReadFile = vi.mocked(readFile);

afterEach(() => {
  mockedReadFile.mockReset();
});

describe("readVercelProjectLink", () => {
  it("reads the matching repository-style link metadata", async () => {
    mockedReadFile
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(
        JSON.stringify({
          projects: [
            { directory: "apps/other", id: "prj_other", name: "other", orgId: "team_other" },
            { directory: "apps/agent", id: "prj_agent", name: "agent", orgId: "team_agent" },
          ],
          remoteName: "origin",
        }),
      );

    await expect(readVercelProjectLink("/repo/apps/agent")).resolves.toEqual({
      orgId: "team_agent",
      projectId: "prj_agent",
      projectName: "agent",
    });
    expect(mockedReadFile).toHaveBeenNthCalledWith(
      1,
      "/repo/apps/agent/.vercel/project.json",
      "utf8",
    );
    expect(mockedReadFile).toHaveBeenNthCalledWith(2, "/repo/apps/agent/.vercel/repo.json", "utf8");
    expect(mockedReadFile).toHaveBeenNthCalledWith(3, "/repo/apps/.vercel/repo.json", "utf8");
    expect(mockedReadFile).toHaveBeenNthCalledWith(4, "/repo/.vercel/repo.json", "utf8");
  });

  it("uses a repo-level owner when the matching project has none", async () => {
    mockedReadFile.mockRejectedValueOnce(new Error("ENOENT")).mockResolvedValueOnce(
      JSON.stringify({
        orgId: "team_repo",
        projects: [{ directory: ".", id: "prj_agent", name: "agent" }],
        remoteName: "origin",
      }),
    );

    await expect(readVercelProjectLink("/agent")).resolves.toEqual({
      orgId: "team_repo",
      projectId: "prj_agent",
      projectName: "agent",
    });
  });

  it("keeps project metadata authoritative when both link formats exist", async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ orgId: "team_project", projectId: "prj_project" }),
    );

    await expect(readVercelProjectLink("/agent")).resolves.toEqual({
      orgId: "team_project",
      projectId: "prj_project",
    });
    expect(mockedReadFile).toHaveBeenCalledOnce();
  });
});
