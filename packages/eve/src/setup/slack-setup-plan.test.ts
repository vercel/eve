import { describe, expect, it } from "vitest";

import type { SlackTriggerDestination } from "./slack-connect.js";
import {
  classifySlackDestination,
  orderSlackConnectorCandidates,
  planSlackRouting,
  type SlackConnectorCandidate,
} from "./slack-setup-plan.js";

const ROUTE = "/eve/v1/slack";
const PROJECT = "prj_this";

const branch: SlackTriggerDestination = { projectId: PROJECT, branch: "preview", path: "/x" };
const customEnvironment: SlackTriggerDestination = {
  projectId: PROJECT,
  customEnvironmentId: "env_staging",
  path: "/x",
};
const otherProject: SlackTriggerDestination = { projectId: "prj_other", path: ROUTE };

describe("classifySlackDestination", () => {
  it.each<[string, SlackTriggerDestination[], string]>([
    ["correct", [{ projectId: PROJECT, path: ROUTE }], "correct"],
    [
      "correct beside a stale entry",
      [
        { projectId: PROJECT, path: "/triggers/slack" },
        { projectId: PROJECT, path: ROUTE },
      ],
      "correct",
    ],
    ["stale default path", [{ projectId: PROJECT, path: "/triggers/slack" }], "stale"],
    ["missing", [otherProject], "missing"],
    ["branch and custom environment entries are ignored", [branch, customEnvironment], "missing"],
  ])("%s", (_name, destinations, expected) => {
    expect(classifySlackDestination(destinations, PROJECT, ROUTE)).toBe(expected);
  });
});

describe("planSlackRouting", () => {
  it("changes nothing for an attached project with the correct destination", () => {
    expect(
      planSlackRouting({
        attached: true,
        destinations: [{ projectId: PROJECT, path: ROUTE }],
        projectId: PROJECT,
        route: ROUTE,
      }),
    ).toEqual({ kind: "none" });
  });

  it("attaches an unattached project, which adds its destination", () => {
    expect(
      planSlackRouting({
        attached: false,
        destinations: [otherProject],
        projectId: PROJECT,
        route: ROUTE,
      }),
    ).toEqual({ kind: "attach" });
  });

  it("adds a missing destination without re-attaching an attached project", () => {
    expect(
      planSlackRouting({
        attached: true,
        destinations: [otherProject],
        projectId: PROJECT,
        route: ROUTE,
      }),
    ).toEqual({
      kind: "replace",
      destinations: [otherProject, { projectId: PROJECT, path: ROUTE }],
    });
  });

  it("replaces only this project's stale default destination", () => {
    expect(
      planSlackRouting({
        attached: true,
        destinations: [otherProject, { projectId: PROJECT, path: "/triggers/slack" }, branch],
        projectId: PROJECT,
        route: ROUTE,
      }),
    ).toEqual({
      kind: "replace",
      destinations: [otherProject, branch, { projectId: PROJECT, path: ROUTE }],
    });
  });

  it("stops before exceeding three destinations, not counting a replaced stale entry", () => {
    const full = [otherProject, branch, customEnvironment];
    expect(
      planSlackRouting({ attached: true, destinations: full, projectId: PROJECT, route: ROUTE }),
    ).toEqual({ kind: "limit-reached", destinations: full });
    expect(
      planSlackRouting({ attached: false, destinations: full, projectId: PROJECT, route: ROUTE }),
    ).toEqual({ kind: "limit-reached", destinations: full });

    const withStale = [otherProject, branch, { projectId: PROJECT, path: "/triggers/slack" }];
    expect(
      planSlackRouting({
        attached: true,
        destinations: withStale,
        projectId: PROJECT,
        route: ROUTE,
      }),
    ).toMatchObject({ kind: "replace" });
  });
});

function candidate(uid: string, createdAt: number, attached: boolean): SlackConnectorCandidate {
  return {
    uid,
    id: `scl_${createdAt}`,
    attached,
    destination: "missing",
    triggerDestinations: [],
    otherProjects: [],
    createdAt,
  };
}

describe("orderSlackConnectorCandidates", () => {
  const named = candidate("slack/named", 1, false);
  const matching = candidate("slack/my-agent", 2, false);
  const olderAttached = candidate("slack/old", 3, true);
  const newerAttached = candidate("slack/new", 4, true);
  const unrelated = candidate("slack/unrelated", 5, false);
  const all = [named, matching, olderAttached, newerAttached, unrelated];

  it.each([
    ["the channel file UID", { channelConnectorUid: "slack/named" }, all, named],
    ["the derived slug", {}, all, matching],
    ["the newest attached connector", {}, [olderAttached, newerAttached, unrelated], newerAttached],
    ["nothing, so a new connector", {}, [unrelated], undefined],
  ])("suggests %s", (_name, input, candidates, expected) => {
    expect(
      orderSlackConnectorCandidates(candidates, { expectedUid: "slack/my-agent", ...input })
        .preferred,
    ).toBe(expected);
  });

  it("lists the suggestion first, then attached connectors, then the rest by age", () => {
    expect(
      orderSlackConnectorCandidates(all, { expectedUid: "slack/my-agent" }).candidates.map(
        (entry) => entry.uid,
      ),
    ).toEqual(["slack/my-agent", "slack/new", "slack/old", "slack/unrelated", "slack/named"]);
  });
});
