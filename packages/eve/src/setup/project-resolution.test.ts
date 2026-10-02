import { describe, expect, it } from "vitest";

import {
  mergeProjectResolution,
  projectResolutionFromDeployResult,
  type ProjectResolution,
} from "./project-resolution.js";

describe("ProjectResolution", () => {
  it("does not carry deployment metadata across project ids", () => {
    const oldProject = {
      kind: "deployed",
      projectId: "prj_old",
      productionUrl: "https://old-agent.vercel.app",
    } satisfies ProjectResolution;
    const nextProject = {
      kind: "linked",
      projectId: "prj_new",
    } satisfies ProjectResolution;

    expect(mergeProjectResolution(oldProject, nextProject)).toEqual({
      kind: "linked",
      projectId: "prj_new",
    });
  });

  it("keeps prior project state when a deployment attempt fails", () => {
    const project = {
      kind: "deployed",
      projectId: "prj_demo",
      productionUrl: "https://old-agent.vercel.app",
    } satisfies ProjectResolution;

    expect(projectResolutionFromDeployResult(project, { deployed: false })).toEqual(project);
  });
});
