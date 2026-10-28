import { describe, expect, it, vi } from "vitest";

import { createSlackSenderProfileResolver } from "#public/channels/slack/sender-profiles.js";

function usersInfo(users: Record<string, Record<string, unknown>>) {
  return vi.fn(async (_operation: string, body: unknown) => {
    const user = users[(body as { user: string }).user];
    return user === undefined ? { ok: false, error: "user_not_found" } : { ok: true, user };
  });
}

describe("createSlackSenderProfileResolver", () => {
  it("prefers the display name and includes the email Slack returns", async () => {
    const request = usersInfo({
      U1: { real_name: "Alice Doe", profile: { display_name: "alice", email: "a@example.com" } },
      U2: { profile: { display_name: "", real_name: "Bob Roe" } },
    });

    const profiles = await createSlackSenderProfileResolver()({
      request,
      teamId: "T1",
      userIds: ["U1", "U2", "U1"],
    });

    expect(profiles.get("U1")).toEqual({ name: "alice", email: "a@example.com" });
    expect(profiles.get("U2")).toEqual({ name: "Bob Roe" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps profiles per workspace and user for an hour", async () => {
    let now = 0;
    const resolve = createSlackSenderProfileResolver(() => now);
    const request = usersInfo({ U1: { profile: { real_name: "Alice" } } });
    const lookup = (teamId: string) => resolve({ request, teamId, userIds: ["U1"] });

    await lookup("T1");
    now = 59 * 60 * 1000;
    expect((await lookup("T1")).get("U1")).toEqual({ name: "Alice" });
    expect(request).toHaveBeenCalledTimes(1);

    await lookup("T2");
    expect(request).toHaveBeenCalledTimes(2);

    now = 61 * 60 * 1000;
    await lookup("T1");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retries a failed lookup after a minute instead of an hour", async () => {
    let now = 0;
    const resolve = createSlackSenderProfileResolver(() => now);
    const request = usersInfo({});
    const lookup = () => resolve({ request, teamId: "T1", userIds: ["U1"] });

    expect((await lookup()).get("U1")).toEqual({});
    now = 59_000;
    await lookup();
    expect(request).toHaveBeenCalledTimes(1);

    now = 61_000;
    await lookup();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("resolves an empty profile when the request throws", async () => {
    const request = vi.fn(async () => {
      throw new Error("network down");
    });

    const profiles = await createSlackSenderProfileResolver()({
      request,
      teamId: "T1",
      userIds: ["U1"],
    });

    expect(profiles.get("U1")).toEqual({});
  });

  it("shares no cached profiles between resolvers", async () => {
    const withEmail = usersInfo({
      U1: { profile: { real_name: "Alice", email: "a@example.com" } },
    });
    const withoutEmail = usersInfo({ U1: { profile: { real_name: "Alice" } } });

    await createSlackSenderProfileResolver()({ request: withEmail, teamId: "T1", userIds: ["U1"] });
    const other = await createSlackSenderProfileResolver()({
      request: withoutEmail,
      teamId: "T1",
      userIds: ["U1"],
    });

    expect(other.get("U1")).toEqual({ name: "Alice" });
  });
});
