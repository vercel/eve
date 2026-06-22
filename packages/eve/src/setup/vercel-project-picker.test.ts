import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { pickExistingVercelProject } from "./vercel-project-picker.js";

describe("pickExistingVercelProject", () => {
  it("uses the searchable picker and searches the full team from its search action", async () => {
    const single = vi
      .fn()
      .mockImplementationOnce((options) => {
        expect(options.search).toBe(true);
        expect(options.placeholder).toBe("type to filter projects");
        expect(options.options.map((option: { label: string }) => option.label)).toEqual([
          "older",
          "newer",
        ]);
        return "\0search-project:found";
      })
      .mockImplementationOnce((options) => {
        expect(options.search).toBe(true);
        expect(options.options.map((option: { label: string }) => option.label)).toEqual([
          "older",
          "newer",
          "found",
        ]);
        return "prj_found";
      });
    const search = vi.fn(async () => [{ id: "prj_found", name: "found" }]);
    const { prompter } = createFakePrompter({ single });

    await expect(
      pickExistingVercelProject({
        prompter,
        team: "team-a",
        projects: [
          { id: "prj_old", name: "older" },
          { id: "prj_new", name: "newer" },
        ],
        search,
      }),
    ).resolves.toEqual({ id: "prj_found", name: "found" });
    expect(search).toHaveBeenCalledWith("found");
  });

  it("appends full-team results to the existing list for a repainting picker", async () => {
    const single = vi.fn(async (options) => {
      const loaded = await options.searchAction.load("found");
      expect(loaded.map((option: { label: string }) => option.label)).toEqual(["recent", "found"]);
      return "prj_found";
    });
    const search = vi.fn(async () => [{ id: "prj_found", name: "found" }]);
    const { prompter } = createFakePrompter({ single });

    await expect(
      pickExistingVercelProject({
        prompter,
        team: "team-a",
        projects: [{ id: "prj_recent", name: "recent" }],
        search,
      }),
    ).resolves.toEqual({ id: "prj_found", name: "found" });
    expect(search).toHaveBeenCalledWith("found");
  });

  it("shows searched results in the same searchable picker", async () => {
    const single = vi
      .fn()
      .mockImplementationOnce((options) => {
        expect(options.search).toBe(true);
        return "\0search-project:found";
      })
      .mockImplementationOnce((options) => {
        expect(options.options.map((option: { label: string }) => option.label)).toEqual([
          "recent-updated",
          "found",
        ]);
        expect(options.search).toBe(true);
        expect(options.initialValue).toBe("prj_recent");
        return "prj_found";
      });
    const search = vi.fn(async () => [
      { id: "prj_recent", name: "recent-updated" },
      { id: "prj_found", name: "found" },
    ]);
    const { prompter } = createFakePrompter({ single });

    await expect(
      pickExistingVercelProject({
        prompter,
        team: "team-a",
        projects: [{ id: "prj_recent", name: "recent" }],
        search,
      }),
    ).resolves.toEqual({ id: "prj_found", name: "found" });
    expect(search).toHaveBeenCalledWith("found");
  });

  it("reports an empty full-team search and reopens the searchable picker", async () => {
    const single = vi
      .fn()
      .mockImplementationOnce((options) => {
        expect(options.search).toBe(true);
        return "\0search-project:missing";
      })
      .mockImplementationOnce((options) => {
        expect(options.options.map((option: { label: string }) => option.label)).toEqual([
          "recent",
        ]);
        expect(options.search).toBe(true);
        expect(options.initialValue).toBe("prj_recent");
        return "prj_recent";
      });
    const { prompter } = createFakePrompter({ single });

    await expect(
      pickExistingVercelProject({
        prompter,
        team: "team-a",
        projects: [{ id: "prj_recent", name: "recent" }],
        search: async () => [],
      }),
    ).resolves.toEqual({ id: "prj_recent", name: "recent" });
    expect(prompter.note).toHaveBeenCalledWith('No projects matched "missing" in team-a.');
  });
});
