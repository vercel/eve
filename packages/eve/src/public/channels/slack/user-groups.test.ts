import { describe, expect, it } from "vitest";

import type { SlackApiResponse } from "#public/channels/slack/api.js";
import {
  registerSlackPreviewAgent,
  resolveSlackPreviewAgentRoute,
  slackUserGroupMentions,
  unregisterSlackPreviewAgent,
  withoutSlackUserGroupMention,
} from "#public/channels/slack/user-groups.js";

const slack = (request: (operation: string, body: unknown) => Promise<SlackApiResponse>) => ({
  request,
  teamId: "T1",
});

const registration = {
  alias: "preview-feature",
  branch: "feature/preview",
  description: "Feature preview.",
  url: "https://preview.example.com",
};

describe("slackUserGroupMentions", () => {
  it("returns unique opaque group ids in mention order", () => {
    expect(
      slackUserGroupMentions("Ask <!subteam^S123|preview> then <!subteam^S456>. <!subteam^S123>"),
    ).toEqual([{ id: "S123" }, { id: "S456" }]);
  });
});

describe("withoutSlackUserGroupMention", () => {
  it("removes only the selected group mention", () => {
    expect(
      withoutSlackUserGroupMention("<!subteam^S123|preview> check <!subteam^S456>", "S123"),
    ).toBe("check <!subteam^S456>");
  });
});

describe("Slack Preview aliases", () => {
  it("creates a bot-owned user group with versioned route metadata", async () => {
    const calls: Array<{ operation: string; body: unknown }> = [];
    const route = await registerSlackPreviewAgent(
      registration,
      slack(async (operation, body) => {
        calls.push({ operation, body });
        if (operation === "auth.test") return { ok: true, team_id: "T1", user_id: "UBOT" };
        if (operation === "usergroups.list") return { ok: true, usergroups: [] };
        if (operation === "usergroups.create") return { ok: true, usergroup: { id: "S1" } };
        if (operation === "usergroups.users.update") return { ok: true };
        throw new Error(`Unexpected ${operation}`);
      }),
    );

    expect(route).toEqual({ ...registration, id: "S1" });
    expect(calls).toEqual([
      { operation: "auth.test", body: {} },
      {
        operation: "usergroups.list",
        body: { include_disabled: true, include_users: true, team_id: "T1" },
      },
      {
        operation: "usergroups.create",
        body: {
          description: `eve:pa:1:${registration.url}`,
          handle: registration.alias,
          name: registration.branch,
          team_id: "T1",
        },
      },
      {
        operation: "usergroups.users.update",
        body: { team_id: "T1", usergroup: "S1", users: "UBOT" },
      },
    ]);
  });

  it("re-enables an unregistered alias so its next mention resolves", async () => {
    const calls: string[] = [];
    let enabled = false;
    let description = "";
    const request = async (operation: string): Promise<SlackApiResponse> => {
      calls.push(operation);
      if (operation === "auth.test") return { ok: true, team_id: "T1", user_id: "UBOT" };
      if (operation === "usergroups.list") {
        return {
          ok: true,
          usergroups: [
            {
              created_by: "UBOT",
              description,
              handle: registration.alias,
              id: "S1",
              is_enabled: enabled,
              name: registration.branch,
              updated_by: "UBOT",
            },
          ],
        };
      }
      if (operation === "usergroups.update") {
        description = `eve:pa:1:${registration.url}`;
        return { ok: true };
      }
      if (operation === "usergroups.enable") {
        enabled = true;
        return { ok: true };
      }
      throw new Error(`Unexpected ${operation}`);
    };

    await expect(registerSlackPreviewAgent(registration, slack(request))).resolves.toEqual({
      ...registration,
      id: "S1",
    });
    await expect(resolveSlackPreviewAgentRoute("<!subteam^S1>", slack(request))).resolves.toEqual({
      ...registration,
      description: "Preview Deployment for feature/preview.",
      id: "S1",
    });
    expect(calls).toEqual([
      "auth.test",
      "usergroups.list",
      "usergroups.update",
      "usergroups.enable",
      "auth.test",
      "usergroups.list",
    ]);
  });

  it("resolves exactly one owned alias and rejects ambiguity", async () => {
    const request = async (operation: string): Promise<SlackApiResponse> => {
      if (operation === "auth.test") return { ok: true, team_id: "T1", user_id: "UBOT" };
      if (operation === "usergroups.list") {
        return {
          ok: true,
          usergroups: [
            {
              created_by: "UBOT",
              description: `eve:pa:1:${registration.url}`,
              handle: registration.alias,
              id: "S1",
              name: registration.branch,
              updated_by: "UBOT",
            },
            {
              created_by: "UBOT",
              description: `eve:pa:1:${registration.url}`,
              handle: "other",
              id: "S2",
              name: registration.branch,
              updated_by: "UBOT",
            },
          ],
        };
      }
      throw new Error(`Unexpected ${operation}`);
    };
    await expect(
      resolveSlackPreviewAgentRoute("<!subteam^S1> investigate", slack(request)),
    ).resolves.toEqual({
      ...registration,
      description: "Preview Deployment for feature/preview.",
      id: "S1",
    });
    await expect(
      resolveSlackPreviewAgentRoute("<!subteam^S1> <!subteam^S2>", slack(request)),
    ).rejects.toThrow("exactly one");
  });

  it("does not resolve a group the bot does not own", async () => {
    await expect(
      resolveSlackPreviewAgentRoute(
        "<!subteam^S1>",
        slack(async (operation): Promise<SlackApiResponse> => {
          if (operation === "auth.test") return { ok: true, team_id: "T1", user_id: "UBOT" };
          if (operation === "usergroups.list") {
            return {
              ok: true,
              usergroups: [
                {
                  created_by: "UHUMAN",
                  handle: registration.alias,
                  id: "S1",
                  updated_by: "UHUMAN",
                },
              ],
            };
          }
          throw new Error(`Unexpected ${operation}`);
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("includes Slack's required scope in failed API errors", async () => {
    await expect(
      registerSlackPreviewAgent(
        registration,
        slack(async (operation): Promise<SlackApiResponse> => {
          if (operation === "auth.test") return { ok: true, team_id: "T1", user_id: "UBOT" };
          if (operation === "usergroups.list") return { ok: true, usergroups: [] };
          if (operation === "usergroups.create") {
            return { error: "missing_scope", needed: "usergroups:write", ok: false };
          }
          throw new Error(`Unexpected ${operation}`);
        }),
      ),
    ).rejects.toThrow("missing_scope (required scope: usergroups:write)");
  });

  it("disables an owned alias", async () => {
    const calls: string[] = [];
    await expect(
      unregisterSlackPreviewAgent(
        registration.alias,
        slack(async (operation): Promise<SlackApiResponse> => {
          calls.push(operation);
          if (operation === "auth.test") return { ok: true, team_id: "T1", user_id: "UBOT" };
          if (operation === "usergroups.list") {
            return {
              ok: true,
              usergroups: [
                { created_by: "UBOT", handle: registration.alias, id: "S1", updated_by: "UBOT" },
              ],
            };
          }
          if (operation === "usergroups.disable") return { ok: true };
          throw new Error(`Unexpected ${operation}`);
        }),
      ),
    ).resolves.toBe(true);
    expect(calls).toEqual(["auth.test", "usergroups.list", "usergroups.disable"]);
  });
});
