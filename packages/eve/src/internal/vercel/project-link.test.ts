import { describe, expect, it } from "vitest";

import { resolveRepoLinkProject, type VercelRepoLink } from "./project-link.js";

function repoLink(overrides: Partial<VercelRepoLink> = {}): VercelRepoLink {
  return {
    orgId: "team_top",
    projects: [{ id: "prj_root", name: "root-app", directory: "." }],
    ...overrides,
  };
}

describe("resolveRepoLinkProject", () => {
  it("resolves a root-directory project for the repo root itself", () => {
    expect(resolveRepoLinkProject(repoLink(), ".")).toEqual({
      projectId: "prj_root",
      orgId: "team_top",
      projectName: "root-app",
    });
  });

  it("prefers the deepest matching directory over the repo root", () => {
    const link = repoLink({
      projects: [
        { id: "prj_root", directory: "." },
        { id: "prj_agent", directory: "apps/agent", orgId: "team_agent" },
      ],
    });
    expect(resolveRepoLinkProject(link, "apps/agent/src")).toEqual({
      projectId: "prj_agent",
      orgId: "team_agent",
    });
  });

  it("prefers a top-level directory over the repo root", () => {
    const link = repoLink({
      projects: [
        { id: "prj_root", directory: "." },
        { id: "prj_web", directory: "web" },
      ],
    });
    expect(resolveRepoLinkProject(link, "web")).toEqual({
      projectId: "prj_web",
      orgId: "team_top",
    });
  });

  it("matches a directory prefix only on whole path segments", () => {
    const link = repoLink({
      projects: [{ id: "prj_agent", directory: "apps/agent" }],
    });
    expect(resolveRepoLinkProject(link, "apps/agent-two")).toBeUndefined();
  });

  it("falls back to the top-level orgId when the project has none", () => {
    const link = repoLink({
      projects: [{ id: "prj_agent", directory: "apps/agent" }],
    });
    expect(resolveRepoLinkProject(link, "apps/agent")).toEqual({
      projectId: "prj_agent",
      orgId: "team_top",
    });
  });

  it("returns undefined when no orgId is resolvable", () => {
    const link: VercelRepoLink = {
      projects: [{ id: "prj_agent", directory: "apps/agent" }],
    };
    expect(resolveRepoLinkProject(link, "apps/agent")).toBeUndefined();
  });

  it("returns undefined when the deepest directory is claimed by several projects", () => {
    const link = repoLink({
      projects: [
        { id: "prj_one", directory: "apps/agent" },
        { id: "prj_two", directory: "apps/agent" },
      ],
    });
    expect(resolveRepoLinkProject(link, "apps/agent")).toBeUndefined();
  });

  it("returns undefined when nothing matches the path", () => {
    const link = repoLink({
      projects: [{ id: "prj_agent", directory: "apps/agent" }],
    });
    expect(resolveRepoLinkProject(link, "apps/other")).toBeUndefined();
  });
});
