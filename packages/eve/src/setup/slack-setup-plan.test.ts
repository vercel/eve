import { describe, expect, it } from "vitest";

import type { SlackTriggerDestination } from "./slack-connect.js";
import {
  orderSlackConnectorCandidates,
  planSlackRouting,
  type SlackConnectorCandidate,
  type SlackRoutingPlan,
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

describe("planSlackRouting", () => {
  const own = { projectId: PROJECT, path: ROUTE };
  const stale = { projectId: PROJECT, path: "/triggers/slack" };

  it.each<[string, boolean, SlackTriggerDestination[], SlackRoutingPlan]>([
    ["changes nothing when attached and routed", true, [own], { kind: "apply", attach: false }],
    [
      "replaces a stale default even beside the correct route",
      true,
      [stale, own, branch],
      { kind: "apply", attach: false, destinations: [branch, own] },
    ],
    [
      "deduplicates two correct default destinations",
      true,
      [own, own],
      { kind: "apply", attach: false, destinations: [own] },
    ],
    ["only attaches when routed but unattached", false, [own], { kind: "apply", attach: true }],
    [
      "adds a missing destination without re-attaching",
      true,
      [otherProject],
      { kind: "apply", attach: false, destinations: [otherProject, own] },
    ],
    [
      "attaches and adds a missing destination",
      false,
      [otherProject],
      { kind: "apply", attach: true, destinations: [otherProject, own] },
    ],
    [
      "attaches and replaces a stale destination",
      false,
      [stale],
      { kind: "apply", attach: true, destinations: [own] },
    ],
    [
      "replaces only this project's stale default destination",
      true,
      [otherProject, stale, branch],
      { kind: "apply", attach: false, destinations: [otherProject, branch, own] },
    ],
  ])("%s", (_name, attached, destinations, expected) => {
    expect(planSlackRouting({ attached, destinations, projectId: PROJECT, route: ROUTE })).toEqual(
      expected,
    );
  });

  it("stops before exceeding three destinations, not counting a replaced stale entry", () => {
    const full = [otherProject, branch, customEnvironment];
    for (const attached of [true, false]) {
      expect(
        planSlackRouting({ attached, destinations: full, projectId: PROJECT, route: ROUTE }),
      ).toEqual({ kind: "limit-reached", destinations: full });
    }
    expect(
      planSlackRouting({
        attached: true,
        destinations: [otherProject, branch, stale],
        projectId: PROJECT,
        route: ROUTE,
      }),
    ).toMatchObject({ kind: "apply" });
  });
});

function candidate(uid: string, createdAt: number, attached: boolean): SlackConnectorCandidate {
  return {
    uid,
    id: `scl_${createdAt}`,
    attached,
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
