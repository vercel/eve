import { describe, expect, it, vi } from "vitest";

import type { SlackApiResponse } from "#public/channels/slack/api.js";
import { createSlackCodeChannel } from "#public/channels/slack/code-channel.js";

function slackApi(input?: {
  readonly create?: SlackApiResponse;
  readonly privacy?: { readonly origin: boolean; readonly created: boolean };
}) {
  const privacy = input?.privacy ?? { created: false, origin: false };
  return vi.fn(async (operation: string, body: unknown): Promise<SlackApiResponse> => {
    if (operation === "conversations.info") {
      const { channel } = body as { channel: string };
      return {
        ok: true,
        channel: { is_private: channel === "C_ORIGIN" ? privacy.origin : privacy.created },
      };
    }
    return input?.create ?? { ok: true, channel_id: "C_CODE" };
  });
}

const ORIGIN = {
  name: "Fix it",
  originChannelId: "C_ORIGIN",
  originTs: "1.2",
  requester: "slack:T1:U1",
};

function createCalls(request: ReturnType<typeof slackApi>): Record<string, string>[] {
  return (request.mock.calls as [string, Record<string, string>][])
    .filter(([operation]) => operation === "agents.conversations.create")
    .map(([, body]) => body);
}

describe("createSlackCodeChannel", () => {
  it("opens a channel linked to the origin message, keyed by origin and requester", async () => {
    const request = slackApi();

    await expect(createSlackCodeChannel({ ...ORIGIN, request })).resolves.toEqual({
      channelId: "C_CODE",
      isPrivate: false,
    });
    await createSlackCodeChannel({ ...ORIGIN, request });

    const [first, second] = createCalls(request);
    expect(first).toEqual({
      name: "Fix it",
      origin_channel_id: "C_ORIGIN",
      origin_message_ts: "1.2",
      session_id: expect.stringMatching(/^[0-9a-f]{32}$/u),
    });
    expect(second!.session_id).toBe(first!.session_id);
  });

  it("tidies the model's channel name and lets Slack name an empty one", async () => {
    const request = slackApi();

    await createSlackCodeChannel({ ...ORIGIN, name: `  Fix\n  the ${"x".repeat(100)}`, request });
    await createSlackCodeChannel({ ...ORIGIN, name: "  \n", request });

    const [long, empty] = createCalls(request);
    expect(long!.name).toBe(`Fix the ${"x".repeat(72)}`);
    expect(empty).not.toHaveProperty("name");
  });

  it("retries only transient Slack errors", async () => {
    for (const error of ["origin_channel_externally_shared", "token_revoked", "unknown_method"]) {
      await expect(
        createSlackCodeChannel({ ...ORIGIN, request: slackApi({ create: { ok: false, error } }) }),
      ).rejects.toMatchObject({ fatal: true });
    }
    const transient = await createSlackCodeChannel({
      ...ORIGIN,
      request: slackApi({ create: { ok: false, error: "ratelimited" } }),
    }).catch((e: unknown) => e);
    expect(transient).toBeInstanceOf(Error);
    expect(transient).not.toHaveProperty("fatal");
  });

  it("asks for a private channel from a private origin, before creating anything", async () => {
    const request = slackApi({ privacy: { created: true, origin: true } });

    await expect(createSlackCodeChannel({ ...ORIGIN, request })).resolves.toEqual({
      channelId: "C_CODE",
      isPrivate: true,
    });

    expect(request.mock.calls[0]![0]).toBe("conversations.info");
    expect(createCalls(request)[0]).toMatchObject({ is_private: true });
  });

  it("archives a public channel Slack opened from a private origin", async () => {
    const request = slackApi({ privacy: { created: false, origin: true } });

    await expect(createSlackCodeChannel({ ...ORIGIN, request })).rejects.toMatchObject({
      fatal: true,
      message: expect.stringContaining("archived it"),
    });
    expect(request).toHaveBeenCalledWith("agents.conversations.archive", { channel_id: "C_CODE" });
  });

  it("creates nothing when the origin can't be read", async () => {
    const request = vi.fn(async (operation: string): Promise<SlackApiResponse> =>
      operation === "conversations.info"
        ? { ok: false, error: "missing_scope" }
        : { ok: true, channel_id: "C_CODE" },
    );

    await expect(createSlackCodeChannel({ ...ORIGIN, request })).rejects.toMatchObject({
      fatal: true,
    });
    expect(createCalls(request)).toHaveLength(0);
  });
});
