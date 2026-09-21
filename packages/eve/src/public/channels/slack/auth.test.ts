import { afterEach, describe, expect, it, vi } from "vitest";

import { admitSlackUser } from "#public/channels/slack/auth.js";

const member = {
  id: "U01",
  team_id: "T01",
  is_restricted: false,
  is_ultra_restricted: false,
  is_bot: false,
  deleted: false,
};
const input = {
  config: { excludeOutsiders: true, credentials: { botToken: "xoxb-test" } },
  installationTeamId: "T01",
  userId: "U01",
};

function mockSlack(user: unknown, installation: unknown = { ok: true, team_id: "T01" }) {
  const fetchMock = vi.fn(async (url: string | URL | Request) =>
    Response.json(String(url).endsWith("auth.test") ? installation : { ok: true, user }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("admitSlackUser", () => {
  it.each([undefined, false])(
    "does no lookup when excludeOutsiders is %s",
    async (excludeOutsiders) => {
      const fetchMock = mockSlack(null);
      expect(await admitSlackUser({ ...input, config: { excludeOutsiders } })).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["full workspace member", member, true],
    ["multi-channel guest", { ...member, is_restricted: true }, false],
    ["single-channel guest", { ...member, is_restricted: true, is_ultra_restricted: true }, false],
    ["ultra-restricted flag alone", { ...member, is_ultra_restricted: true }, false],
    [
      "external Slack Connect member visible to the app",
      { ...member, team_id: "T_OTHER", is_stranger: false },
      false,
    ],
    ["external flag", { ...member, is_external: true }, false],
    ["stranger", { ...member, is_stranger: true }, false],
    ["deleted account", { ...member, deleted: true }, false],
    ["bot", { ...member, is_bot: true }, false],
    ["missing guest flag", { ...member, is_restricted: undefined }, false],
    ["missing single-channel guest flag", { ...member, is_ultra_restricted: undefined }, false],
    ["wrong user", { ...member, id: "U_OTHER" }, false],
    ["missing workspace", { ...member, team_id: undefined }, false],
    ["missing user", null, false],
    [
      "enterprise member of this workspace",
      { ...member, team_id: "T_OTHER", enterprise_user: { teams: ["T01"] } },
      true,
    ],
    [
      "enterprise member of another workspace",
      { ...member, team_id: "T_OTHER", enterprise_user: { teams: ["T_OTHER"] } },
      false,
    ],
    [
      "enterprise guest",
      { ...member, is_restricted: true, enterprise_user: { teams: ["T01"] } },
      false,
    ],
  ])("checks %s", async (_name, user, allowed) => {
    mockSlack(user);
    expect(await admitSlackUser(input)).toBe(allowed);
  });

  it("anchors membership to the token, not the event workspace, and resolves the token once", async () => {
    const fetchMock = mockSlack(member);
    const botToken = vi.fn(() => "xoxb-installation");
    expect(
      await admitSlackUser({
        ...input,
        config: { excludeOutsiders: true, credentials: { botToken } },
        installationTeamId: "T_EVENT",
      }),
    ).toBe(true);
    expect(botToken).toHaveBeenCalledExactlyOnceWith({ teamId: "T_EVENT" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://slack.com/api/auth.test",
      "https://slack.com/api/users.info",
    ]);
  });

  it.each([{ ok: false }, { ok: true }, { ok: true, team_id: "" }])(
    "rejects an unverifiable token workspace: %j",
    async (installation) => {
      const fetchMock = mockSlack(member, installation);
      expect(await admitSlackUser(input)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, null, "", { id: "U01" }])(
    "rejects an absent or unsupported actor: %j",
    async (userId) => {
      const fetchMock = mockSlack(member);
      expect(await admitSlackUser({ ...input, userId })).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects Slack API errors, including missing scope and rate limits", async () => {
    for (const error of ["missing_scope", "ratelimited", "user_not_found"]) {
      const fetchMock = mockSlack(member);
      fetchMock.mockResolvedValueOnce(Response.json({ ok: true, team_id: "T01" }));
      fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error }));
      expect(await admitSlackUser(input)).toBe(false);
    }
  });

  it("rejects network and credential failures", async () => {
    const fetchMock = mockSlack(member);
    fetchMock.mockRejectedValue(new Error("unavailable"));
    expect(await admitSlackUser(input)).toBe(false);
    expect(
      await admitSlackUser({
        ...input,
        config: {
          excludeOutsiders: true,
          credentials: {
            botToken: () => {
              throw new Error("unavailable");
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("rechecks guest status on each request", async () => {
    const fetchMock = mockSlack(member);
    expect(await admitSlackUser(input)).toBe(true);
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true, team_id: "T01" }));
    fetchMock.mockResolvedValueOnce(
      Response.json({ ok: true, user: { ...member, is_restricted: true } }),
    );
    expect(await admitSlackUser(input)).toBe(false);
  });
});
