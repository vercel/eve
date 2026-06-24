import { describe, expect, it } from "vitest";

import {
  mergeProjectResolution,
  projectReferenceFromEnvironment,
  projectResolutionFromDeployResult,
  type ProjectResolution,
} from "./project-resolution.js";

describe("projectReferenceFromEnvironment", () => {
  it("parses a complete owner and project pair", () => {
    expect(
      projectReferenceFromEnvironment({
        VERCEL_ORG_ID: "team_example",
        VERCEL_PROJECT_ID: "prj_example",
      }),
    ).toEqual({ orgId: "team_example", projectId: "prj_example" });
  });

  it("rejects incomplete and empty pairs", () => {
    expect(projectReferenceFromEnvironment({ VERCEL_ORG_ID: "team_example" })).toBeUndefined();
    expect(projectReferenceFromEnvironment({ VERCEL_PROJECT_ID: "prj_example" })).toBeUndefined();
    expect(
      projectReferenceFromEnvironment({ VERCEL_ORG_ID: "", VERCEL_PROJECT_ID: "prj_example" }),
    ).toBeUndefined();
  });
});

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
