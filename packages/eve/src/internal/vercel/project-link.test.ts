import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readVercelProjectLink } from "./project-link.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const mockedReadFile = vi.mocked(readFile);

afterEach(() => {
  mockedReadFile.mockReset();
});

describe("readVercelProjectLink", () => {
  it("reads repository-style link metadata", async () => {
    mockedReadFile
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(JSON.stringify({ orgId: "team_example", projectId: "prj_example" }));

    await expect(readVercelProjectLink("/agent")).resolves.toEqual({
      orgId: "team_example",
      projectId: "prj_example",
    });
    expect(mockedReadFile).toHaveBeenNthCalledWith(1, "/agent/.vercel/project.json", "utf8");
    expect(mockedReadFile).toHaveBeenNthCalledWith(2, "/agent/.vercel/repo.json", "utf8");
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
