import { describe, expect, it, vi } from "vitest";

import {
  localDevAuth,
  slackAuth,
  slackBotAuth,
  webAuth,
} from "../testing/session";
import { requireAnalystRole, resolveAnalystRole } from "./access";
import { parseAnalystConfig } from "./config";

const config = (env: Record<string, string> = {}) =>
  parseAnalystConfig({ ANALYST_DATABASE_URL: "postgres://db/app", ...env });
const roleMap = (map: Record<string, string>, env = {}) =>
  config({ ANALYST_ROLE_MAP: JSON.stringify(map), ...env });

describe(resolveAnalystRole, () => {
  it.each([
    ["a Slack user", slackAuth()],
    ["a web user", webAuth()],
    ["local development", localDevAuth()],
  ])("gives %s the default role", (_name, auth) => {
    expect(resolveAnalystRole(auth, config())).toStrictEqual({
      ok: true,
      role: "analyst_readonly",
    });
  });

  it("uses a mapped role for a Slack user", () => {
    expect(
      resolveAnalystRole(
        slackAuth(),
        roleMap({ "slack:T123:U123": "analyst_finance" })
      )
    ).toStrictEqual({ ok: true, role: "analyst_finance" });
  });

  it("denies a user mapped to an empty role", () => {
    expect(
      resolveAnalystRole(slackAuth(), roleMap({ "slack:T123:U123": "" }))
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("turned off"),
    });
  });

  it("denies unmapped people in allowlist mode", () => {
    const allowlist = roleMap(
      { "slack:T123:U999": "analyst_readonly" },
      { ANALYST_DEFAULT_ROLE: "" }
    );
    expect(resolveAnalystRole(slackAuth(), allowlist)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ANALYST_ROLE_MAP"),
    });
    expect(
      resolveAnalystRole(slackAuth({ userId: "U999" }), allowlist)
    ).toStrictEqual({ ok: true, role: "analyst_readonly" });
  });

  it("denies a Slack bot unless it is mapped", () => {
    expect(resolveAnalystRole(slackBotAuth(), config())).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Bots"),
    });
    expect(
      resolveAnalystRole(
        slackBotAuth(),
        roleMap({ "slack:T123:bot:B123": "analyst_reports" })
      )
    ).toStrictEqual({ ok: true, role: "analyst_reports" });
  });

  it.each([
    ["runtime callers", { ...webAuth("runtime"), principalType: "runtime" }],
    [
      "anonymous callers",
      { ...webAuth("anonymous"), principalType: "anonymous" },
    ],
    ["missing auth", null],
  ])("denies %s", (_name, auth) => {
    expect(resolveAnalystRole(auth, config()).ok).toBe(false);
  });

  it("does not resolve principal IDs through the object prototype", () => {
    expect(resolveAnalystRole(webAuth("constructor"), config())).toStrictEqual({
      ok: true,
      role: "analyst_readonly",
    });
  });
});

describe("Slack user and channel entries", () => {
  const finance = slackAuth({ channelId: "C0FINANCE", userId: "U0ALICE" });

  it("matches a bare Slack user ID", () => {
    expect(
      resolveAnalystRole(finance, roleMap({ U0ALICE: "analyst_finance" }))
    ).toStrictEqual({ ok: true, role: "analyst_finance" });
  });

  it("gives everyone in a mapped channel the channel's role", () => {
    const map = roleMap({ C0FINANCE: "analyst_finance" });
    expect(resolveAnalystRole(finance, map)).toStrictEqual({
      ok: true,
      role: "analyst_finance",
    });
    expect(
      resolveAnalystRole(
        slackAuth({ channelId: "C0GENERAL", userId: "U0ALICE" }),
        map
      )
    ).toStrictEqual({ ok: true, role: "analyst_readonly" });
  });

  it("prefers the channel's role over the person's own role inside that channel", () => {
    const map = roleMap({
      C0FINANCE: "analyst_finance",
      U0ALICE: "analyst_exec",
    });
    expect(resolveAnalystRole(finance, map)).toStrictEqual({
      ok: true,
      role: "analyst_finance",
    });
    expect(
      resolveAnalystRole(
        slackAuth({ channelId: "C0GENERAL", userId: "U0ALICE" }),
        map
      )
    ).toStrictEqual({ ok: true, role: "analyst_exec" });
  });

  it.each([
    ["a bare user ID", { C0FINANCE: "analyst_finance", U0ALICE: "" }],
    [
      "a full principal ID",
      { C0FINANCE: "analyst_finance", "slack:T123:U0ALICE": "" },
    ],
  ])("lets a personal denial by %s win over a channel role", (_name, map) => {
    expect(resolveAnalystRole(finance, roleMap(map))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("turned off"),
    });
  });

  it.each([
    [
      "a full-principal grant with a bare-ID denial",
      { U0ALICE: "", "slack:T123:U0ALICE": "analyst_finance" },
    ],
    [
      "a bare-ID grant with a full-principal denial",
      { U0ALICE: "analyst_finance", "slack:T123:U0ALICE": "" },
    ],
  ])("denies %s", (_name, map) => {
    const channelRoles: Record<string, string>[] = [
      {},
      { C0FINANCE: "analyst_finance" },
    ];
    for (const extra of channelRoles) {
      expect(
        resolveAnalystRole(finance, roleMap({ ...map, ...extra }))
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("turned off"),
      });
    }
  });

  it("prefers the full principal ID when both forms name a role", () => {
    expect(
      resolveAnalystRole(
        slackAuth({ channelId: "C0GENERAL", userId: "U0ALICE" }),
        roleMap({
          U0ALICE: "analyst_readonly",
          "slack:T123:U0ALICE": "analyst_exec",
        })
      )
    ).toStrictEqual({ ok: true, role: "analyst_exec" });
  });

  it("can turn questions off in a channel", () => {
    expect(
      resolveAnalystRole(finance, roleMap({ C0FINANCE: "" }))
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("this channel"),
    });
  });

  it("never gives channel roles to bots", () => {
    expect(
      resolveAnalystRole(
        slackBotAuth({ channelId: "C0FINANCE" }),
        roleMap({ C0FINANCE: "analyst_finance" })
      ).ok
    ).toBe(false);
  });

  it("ignores Slack-looking attributes on non-Slack callers", () => {
    const web = {
      ...webAuth(),
      attributes: { channel_id: "C0FINANCE", user_id: "U0ALICE" },
    };
    expect(
      resolveAnalystRole(
        web,
        roleMap({ C0FINANCE: "analyst_finance", U0ALICE: "analyst_exec" })
      )
    ).toStrictEqual({ ok: true, role: "analyst_readonly" });
  });
});

describe("principal IDs shaped like Slack IDs", () => {
  const map = { C0FINANCE: "analyst_finance", U0ALICE: "analyst_exec" };

  it.each(["U0ALICE", "C0FINANCE"])(
    "never matches %s as a non-Slack principal ID",
    (principalId) => {
      expect(
        resolveAnalystRole(webAuth(principalId), roleMap(map))
      ).toStrictEqual({ ok: true, role: "analyst_readonly" });
      expect(
        resolveAnalystRole(
          webAuth(principalId),
          roleMap(map, { ANALYST_DEFAULT_ROLE: "" })
        )
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("ANALYST_ROLE_MAP"),
      });
    }
  );

  it("denies a service caller whose principal ID looks like a Slack ID", () => {
    expect(
      resolveAnalystRole(
        { ...webAuth("U0ALICE"), principalType: "service" },
        roleMap(map)
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining("Bots") });
  });

  it("ignores an empty entry for a Slack-shaped non-Slack principal ID", () => {
    expect(
      resolveAnalystRole(webAuth("U0ALICE"), roleMap({ U0ALICE: "" }))
    ).toStrictEqual({ ok: true, role: "analyst_readonly" });
  });
});

describe(requireAnalystRole, () => {
  it("returns the role or throws the denial reason", () => {
    vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
    expect(requireAnalystRole({ auth: { current: slackAuth() } })).toBe(
      "analyst_readonly"
    );
    expect(() =>
      requireAnalystRole({ auth: { current: slackBotAuth() } })
    ).toThrow("Bots");
  });
});
