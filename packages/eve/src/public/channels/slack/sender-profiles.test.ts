import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearSlackSenderProfileCache,
  resolveSlackSenderProfiles,
} from "#public/channels/slack/sender-profiles.js";

afterEach(() => clearSlackSenderProfileCache());

function usersInfo(users: Record<string, Record<string, unknown>>) {
  return vi.fn(async (_operation: string, body: unknown) => {
    const user = users[(body as { user: string }).user];
    return user === undefined ? { ok: false, error: "user_not_found" } : { ok: true, user };
  });
}

describe("resolveSlackSenderProfiles", () => {
  it("prefers the display name and includes the email Slack returns", async () => {
    const request = usersInfo({
      U1: { real_name: "Alice Doe", profile: { display_name: "alice", email: "a@example.com" } },
      U2: { profile: { display_name: "", real_name: "Bob Roe" } },
    });

    const profiles = await resolveSlackSenderProfiles({
      request,
      teamId: "T1",
      userIds: ["U1", "U2", "U1"],
    });

    expect(profiles.get("U1")).toEqual({ name: "alice", email: "a@example.com" });
    expect(profiles.get("U2")).toEqual({ name: "Bob Roe" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("caches lookups, including failures, per workspace and user for an hour", async () => {
    const request = usersInfo({ U1: { profile: { real_name: "Alice" } } });
    const lookup = (teamId: string, now: number) =>
      resolveSlackSenderProfiles({ request, teamId, userIds: ["U1", "U_GONE"], now });

    await lookup("T1", 0);
    const cached = await lookup("T1", 59 * 60 * 1000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(cached.get("U1")).toEqual({ name: "Alice" });
    expect(cached.get("U_GONE")).toEqual({});

    await lookup("T2", 0);
    expect(request).toHaveBeenCalledTimes(4);

    await lookup("T1", 61 * 60 * 1000);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("resolves an empty profile when the request throws", async () => {
    const request = vi.fn(async () => {
      throw new Error("network down");
    });

    const profiles = await resolveSlackSenderProfiles({ request, teamId: "T1", userIds: ["U1"] });

    expect(profiles.get("U1")).toEqual({});
  });
});
