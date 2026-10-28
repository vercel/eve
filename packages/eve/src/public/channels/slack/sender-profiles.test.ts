import { describe, expect, it, vi } from "vitest";

import type { SlackApiResponse, SlackWorkspaceHandle } from "#public/channels/slack/api.js";
import {
  createCachedSlackSenderProfileLookup,
  fetchSlackSenderProfile,
  resolveSlackSenderProfiles,
  type SlackSenderProfileLookup,
} from "#public/channels/slack/sender-profiles.js";

function workspace(users: Record<string, Record<string, unknown>>) {
  const request = vi.fn(async (_operation: string, body: unknown): Promise<SlackApiResponse> => {
    const user = users[(body as { user: string }).user];
    return user === undefined ? { ok: false, error: "user_not_found" } : { ok: true, user };
  });
  const slack: SlackWorkspaceHandle = { teamId: "T1", request };
  return { request, slack };
}

describe("fetchSlackSenderProfile", () => {
  it("prefers the display name and includes the email Slack returns", async () => {
    const { slack } = workspace({
      U1: { real_name: "Alice Doe", profile: { display_name: "alice", email: "a@example.com" } },
      U2: { profile: { display_name: "", real_name: "Bob Roe" } },
    });

    await expect(fetchSlackSenderProfile({ userId: "U1", slack })).resolves.toEqual({
      name: "alice",
      email: "a@example.com",
    });
    await expect(fetchSlackSenderProfile({ userId: "U2", slack })).resolves.toEqual({
      name: "Bob Roe",
    });
  });

  it("throws with a reinstall hint when the users:read scope is missing", async () => {
    const slack = { request: async () => ({ ok: false, error: "missing_scope" }) };

    await expect(fetchSlackSenderProfile({ userId: "U1", slack })).rejects.toThrow(
      /users:read scope.*reinstall the Slack app/u,
    );
  });
});

describe("createCachedSlackSenderProfileLookup", () => {
  it("keeps profiles per workspace and user for an hour", async () => {
    let now = 0;
    const lookup = createCachedSlackSenderProfileLookup(() => now);
    const { request, slack } = workspace({ U1: { profile: { real_name: "Alice" } } });
    const get = (teamId: string) => lookup({ userId: "U1", teamId, slack });

    await get("T1");
    now = 59 * 60 * 1000;
    await expect(get("T1")).resolves.toEqual({ name: "Alice" });
    expect(request).toHaveBeenCalledTimes(1);

    await get("T2");
    expect(request).toHaveBeenCalledTimes(2);

    now = 61 * 60 * 1000;
    await get("T1");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retries a failed lookup after a minute instead of an hour", async () => {
    let now = 0;
    const lookup = createCachedSlackSenderProfileLookup(() => now);
    const { request, slack } = workspace({});
    const get = () => lookup({ userId: "U1", teamId: "T1", slack });

    await expect(get()).resolves.toBeUndefined();
    now = 59_000;
    await get();
    expect(request).toHaveBeenCalledTimes(1);

    now = 61_000;
    await get();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares no cached profiles between lookups", async () => {
    const withEmail = workspace({
      U1: { profile: { real_name: "Alice", email: "a@example.com" } },
    });
    const withoutEmail = workspace({ U1: { profile: { real_name: "Alice" } } });

    await createCachedSlackSenderProfileLookup()({ userId: "U1", teamId: "T1", ...withEmail });
    const other = await createCachedSlackSenderProfileLookup()({
      userId: "U1",
      teamId: "T1",
      ...withoutEmail,
    });

    expect(other).toEqual({ name: "Alice" });
  });
});

describe("resolveSlackSenderProfiles", () => {
  it("calls the lookup once per distinct sender with the workspace", async () => {
    const { slack } = workspace({});
    const lookup = vi.fn<SlackSenderProfileLookup>(async ({ userId }) =>
      userId === "U_EMPTY" ? undefined : { name: userId.toLowerCase() },
    );

    const profiles = await resolveSlackSenderProfiles({
      lookup,
      slack,
      teamId: "T_INSTALL",
      userIds: ["U1", "U_EMPTY", "U1"],
    });

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledWith({ userId: "U1", teamId: "T_INSTALL", slack });
    expect([...profiles]).toEqual([["U1", { name: "u1" }]]);
  });

  it("omits a sender whose lookup throws", async () => {
    const { slack } = workspace({});
    const lookup: SlackSenderProfileLookup = async ({ userId }) => {
      if (userId === "U_BAD") throw new Error("cache down");
      return { name: "Alice" };
    };

    const profiles = await resolveSlackSenderProfiles({
      lookup,
      slack,
      teamId: "T1",
      userIds: ["U_BAD", "U1"],
    });

    expect([...profiles]).toEqual([["U1", { name: "Alice" }]]);
  });
});
