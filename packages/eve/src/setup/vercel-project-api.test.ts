import { beforeEach, describe, expect, it, vi } from "vitest";

import { captureVercel, type VercelCaptureResult } from "#setup/primitives/index.js";

import { listRecentProjects, listTeams, searchProjects } from "./vercel-project-api.js";

vi.mock("#setup/primitives/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#setup/primitives/index.js")>()),
  captureVercel: vi.fn(),
}));

const mockedCaptureVercel = vi.mocked(captureVercel);
const captured = (value: unknown): VercelCaptureResult => ({
  ok: true,
  stdout: JSON.stringify(value),
});
const failed = (stderr: string): VercelCaptureResult => ({
  ok: false,
  failure: { code: 1, message: "Vercel CLI failed.", stderr, stdout: "" },
});

beforeEach(() => {
  mockedCaptureVercel.mockReset();
});

describe("listTeams", () => {
  it("drains every page and deduplicates by slug", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured({
          teams: [{ name: "Current", slug: "current", current: true }],
          pagination: { next: 20 },
        }),
      )
      .mockResolvedValueOnce(
        captured({
          teams: [
            { name: "Current", slug: "current", current: true },
            { name: "Other", slug: "other", current: false },
          ],
          pagination: { next: null },
        }),
      );

    await expect(listTeams("/repo")).resolves.toEqual([
      { name: "Current", slug: "current", current: true },
      { name: "Other", slug: "other", current: false },
    ]);
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      ["teams", "ls", "--format", "json", "--next", "20"],
      { cwd: "/repo", signal: undefined },
    );
  });

  it("rejects a repeated pagination cursor", async () => {
    mockedCaptureVercel.mockResolvedValue(captured({ teams: [], pagination: { next: 20 } }));

    await expect(listTeams("/repo")).rejects.toThrow("repeated pagination cursor");
  });

  it("rejects an invalid entry instead of returning a partial page", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured({ teams: [{ name: "Missing current", slug: "broken" }] }),
    );

    await expect(listTeams("/repo")).rejects.toThrow("Could not read teams");
  });
});

describe("listRecentProjects", () => {
  it("returns one team-scoped page without following its cursor", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured({
        projects: [{ id: "prj_recent", name: "recent" }],
        pagination: { next: 8 },
      }),
    );

    await expect(listRecentProjects("/repo", "team-a")).resolves.toEqual([
      { id: "prj_recent", name: "recent" },
    ]);
    expect(mockedCaptureVercel).toHaveBeenCalledOnce();
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["project", "ls", "--format", "json", "--scope", "team-a"],
      { cwd: "/repo", signal: undefined, timeoutMs: 15_000 },
    );
  });

  it("routes a scoped SSO denial to a human action", async () => {
    mockedCaptureVercel.mockResolvedValue(failed("This team requires SAML Single Sign-On."));

    await expect(listRecentProjects("/repo", "team-a")).rejects.toMatchObject({
      name: "HumanActionRequiredError",
      action: { kind: "vercel-forbidden", command: "vercel login" },
    });
  });

  it("honors cancellation that lands while the CLI result is settling", async () => {
    const abort = new AbortController();
    mockedCaptureVercel.mockImplementation(async () => {
      abort.abort();
      return captured({ projects: [] });
    });

    await expect(
      listRecentProjects("/repo", "team-a", { signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("searchProjects", () => {
  it("searches every matching page under the selected team", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured({
          projects: [{ id: "prj_a", name: "agent" }],
          pagination: { next: 7 },
        }),
      )
      .mockResolvedValueOnce(
        captured({
          projects: [
            { id: "prj_a", name: "agent" },
            { id: "prj_b", name: "agent-api" },
          ],
          pagination: { next: null },
        }),
      );

    await expect(searchProjects("/repo", "team-a", " agent ")).resolves.toEqual([
      { id: "prj_a", name: "agent" },
      { id: "prj_b", name: "agent-api" },
    ]);
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      1,
      ["project", "ls", "--format", "json", "--scope", "team-a", "--filter", "agent"],
      { cwd: "/repo", signal: undefined, timeoutMs: 15_000 },
    );
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      [
        "project",
        "ls",
        "--format",
        "json",
        "--scope",
        "team-a",
        "--filter",
        "agent",
        "--next",
        "7",
      ],
      { cwd: "/repo", signal: undefined, timeoutMs: 15_000 },
    );
  });

  it("rejects empty queries and repeated cursors", async () => {
    await expect(searchProjects("/repo", "team-a", "  ")).rejects.toThrow("cannot be empty");

    mockedCaptureVercel.mockResolvedValue(captured({ projects: [], pagination: { next: 7 } }));
    await expect(searchProjects("/repo", "team-a", "agent")).rejects.toThrow(
      "repeated pagination cursor",
    );
  });
});
