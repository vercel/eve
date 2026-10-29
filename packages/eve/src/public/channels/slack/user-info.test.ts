import { afterEach, describe, expect, it, vi } from "vitest";

import type { SlackApiResponse } from "#public/channels/slack/api.js";
import type { SlackMessage } from "#public/channels/slack/inbound.js";
import {
  createSlackUserResolver,
  resolveSlackUsers,
  withSlackUserInfo,
} from "#public/channels/slack/user-info.js";

function slackUsers(users: Record<string, Record<string, unknown>>) {
  return vi.fn(async (_operation: string, body: unknown): Promise<SlackApiResponse> => {
    const user = users[(body as { user: string }).user];
    return user === undefined ? { ok: false, error: "user_not_found" } : { ok: true, user };
  });
}

const alice = {
  real_name: "Alice Doe",
  profile: { display_name: "alice", email: "a@example.com" },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createSlackUserResolver", () => {
  it("is off unless messageContext.users is set", () => {
    expect(createSlackUserResolver(undefined)).toBeUndefined();
    expect(createSlackUserResolver(false)).toBeUndefined();
    expect(createSlackUserResolver({ name: false })).toBeUndefined();
  });

  it("returns names only unless email is requested", async () => {
    const request = slackUsers({ U1: alice });

    await expect(
      createSlackUserResolver(true)!({ userId: "U1", teamId: "T1", request }),
    ).resolves.toEqual({ displayName: "alice", realName: "Alice Doe" });
    await expect(
      createSlackUserResolver({ email: true })!({ userId: "U1", teamId: "T1", request }),
    ).resolves.toEqual({ displayName: "alice", realName: "Alice Doe", email: "a@example.com" });
    await expect(
      createSlackUserResolver({ name: false, email: true })!({
        userId: "U1",
        teamId: "T1",
        request,
      }),
    ).resolves.toEqual({ email: "a@example.com" });
  });

  it("keeps profiles per workspace and user for an hour", async () => {
    let now = 0;
    const resolver = createSlackUserResolver(true, () => now)!;
    const request = slackUsers({ U1: alice });
    const get = (teamId: string) => resolver({ userId: "U1", teamId, request });

    await get("T1");
    now = 59 * 60 * 1000;
    await get("T1");
    expect(request).toHaveBeenCalledTimes(1);

    await get("T2");
    expect(request).toHaveBeenCalledTimes(2);

    now = 61 * 60 * 1000;
    await get("T1");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retries a failed lookup after a minute instead of an hour", async () => {
    let now = 0;
    const resolver = createSlackUserResolver(true, () => now)!;
    const request = slackUsers({});
    const get = () => resolver({ userId: "U1", teamId: "T1", request });

    await expect(get()).resolves.toBeUndefined();
    now = 59_000;
    await get();
    expect(request).toHaveBeenCalledTimes(1);

    now = 61_000;
    await get();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares no cached profiles between channels", async () => {
    await createSlackUserResolver({ email: true })!({
      userId: "U1",
      teamId: "T1",
      request: slackUsers({ U1: alice }),
    });
    const other = await createSlackUserResolver({ email: true })!({
      userId: "U1",
      teamId: "T1",
      request: slackUsers({ U1: { profile: { real_name: "Alice" } } }),
    });

    expect(other).toEqual({ realName: "Alice" });
  });

  it("hands an authored resolve the user and an uncached users.info next()", async () => {
    const request = slackUsers({ U1: alice });
    const resolve = vi.fn(
      async (_user: { readonly userId: string }, next: () => Promise<object>) => await next(),
    );
    const resolver = createSlackUserResolver({ resolve })!;

    await resolver({ userId: "U1", teamId: "T1", request });
    await expect(resolver({ userId: "U1", teamId: "T1", request })).resolves.toEqual({
      displayName: "alice",
      realName: "Alice Doe",
    });

    expect(resolve).toHaveBeenCalledWith({ userId: "U1", teamId: "T1" }, expect.any(Function));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("omits a user whose resolve throws", async () => {
    const resolver = createSlackUserResolver({
      resolve: async () => {
        throw new Error("cache down");
      },
    })!;

    await expect(
      resolver({ userId: "U1", teamId: "T1", request: slackUsers({}) }),
    ).resolves.toBeUndefined();
  });

  it("gives up on a lookup that never settles", async () => {
    vi.useFakeTimers();
    const resolver = createSlackUserResolver({ resolve: () => new Promise(() => {}) })!;

    const pending = resolver({ userId: "U1", teamId: "T1", request: slackUsers({}) });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(pending).resolves.toBeUndefined();
  });
});

describe("resolveSlackUsers", () => {
  it("resolves each distinct user once and drops empty results", async () => {
    const request = slackUsers({ U1: alice });

    const users = await resolveSlackUsers(createSlackUserResolver(true)!, {
      request,
      teamId: "T1",
      userIds: ["U1", "U_MISSING", "U1"],
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect([...users]).toEqual([["U1", { displayName: "alice", realName: "Alice Doe" }]]);
  });
});

describe("withSlackUserInfo", () => {
  const message = {
    author: { userId: "U1", userName: undefined, fullName: undefined, isBot: false, isMe: false },
  } as SlackMessage;

  it("writes the looked-up profile into the author", async () => {
    const resolved = await withSlackUserInfo(message, createSlackUserResolver({ email: true })!, {
      request: slackUsers({ U1: alice }),
      teamId: "T1",
    });

    expect(resolved.author).toMatchObject({
      userId: "U1",
      fullName: "Alice Doe",
      displayName: "alice",
      email: "a@example.com",
    });
  });

  it("skips bot authors", async () => {
    const request = slackUsers({ U1: alice });
    const bot = { author: { ...message.author!, isBot: true } } as SlackMessage;

    await expect(
      withSlackUserInfo(bot, createSlackUserResolver(true)!, { request, teamId: "T1" }),
    ).resolves.toBe(bot);
    expect(request).not.toHaveBeenCalled();
  });
});
