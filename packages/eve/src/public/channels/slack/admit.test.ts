import { afterEach, describe, expect, it, vi } from "vitest";

import { isExternalSlackConversation, isSlackGuest } from "#public/channels/slack/admit.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubSlack(responses: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: string | URL | Request) => {
      const operation = String(request).split("/").at(-1)!;
      return Response.json(responses[operation] ?? { ok: false, error: "unknown_method" });
    }),
  );
}

describe("isExternalSlackConversation", () => {
  it.each([
    [{ is_ext_shared: true, is_shared: true }, true],
    [{ is_pending_ext_shared: true }, true],
    [{ is_shared: true }, true],
    [{ is_org_shared: true, is_shared: true }, false],
    [{ is_private: true }, false],
  ])("classifies %o as external: %s", async (channel, external) => {
    stubSlack({ "conversations.info": { ok: true, channel } });

    await expect(
      isExternalSlackConversation({
        botToken: "xoxb-test",
        channelId: `C_${JSON.stringify(channel)}`,
      }),
    ).resolves.toBe(external);
  });

  it("treats a conversation it can't look up as external", async () => {
    stubSlack({ "conversations.info": { ok: false, error: "missing_scope" } });

    await expect(
      isExternalSlackConversation({ botToken: "xoxb-test", channelId: "C_MISSING_SCOPE" }),
    ).resolves.toBe(true);
  });
});

describe("isSlackGuest", () => {
  it.each([
    [{ is_restricted: true }, true],
    [{ is_ultra_restricted: true }, true],
    [{}, false],
  ])("classifies %o as a guest: %s", async (user, guest) => {
    stubSlack({ "users.info": { ok: true, user } });

    await expect(
      isSlackGuest({ botToken: "xoxb-test", userId: `U_${JSON.stringify(user)}` }),
    ).resolves.toBe(guest);
  });

  it("treats a user it can't look up as a guest", async () => {
    stubSlack({ "users.info": { ok: false, error: "missing_scope" } });

    await expect(isSlackGuest({ botToken: "xoxb-test", userId: "U_MISSING_SCOPE" })).resolves.toBe(
      true,
    );
  });
});
