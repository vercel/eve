import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSlackTurnMessage,
  collectInboundFileParts,
  collectSlackFileParts,
  createSlackFetchFile,
} from "#public/channels/slack/attachments.js";
import type { SlackAttachment } from "#public/channels/slack/inbound.js";
import {
  resolveSlackTransportOptions,
  type SlackTransportOptions,
} from "#public/channels/slack/transport.js";
import { DEFAULT_UPLOAD_POLICY, mergeUploadPolicy } from "#public/channels/upload-policy.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

const DISABLED_POLICY = mergeUploadPolicy("disabled");
const ZERO_BYTES_POLICY = mergeUploadPolicy({ maxBytes: 0 });
const EMPTY_MEDIA_TYPES_POLICY = mergeUploadPolicy({ allowedMediaTypes: [] });

function makeAttachments(
  attachments: Array<Partial<SlackAttachment> & { type: SlackAttachment["type"] }>,
): SlackAttachment[] {
  return attachments.map((a, index) => ({
    id: a.id ?? `F${index}`,
    type: a.type,
    url: a.url,
    name: a.name,
    mimeType: a.mimeType,
    size: a.size,
  }));
}

describe("collectSlackFileParts", () => {
  it("emits one FilePart per supported attachment", () => {
    const attachments = makeAttachments([
      {
        type: "file",
        url: "https://files.slack.com/a/b/report.csv",
        name: "report.csv",
        mimeType: "text/csv",
        size: 512,
      },
      {
        type: "image",
        url: "https://files.slack.com/a/b/cat.png",
        name: "cat.png",
        mimeType: "image/png",
        size: 4_096,
      },
    ]);

    const parts = collectSlackFileParts(attachments, DEFAULT_UPLOAD_POLICY);

    expect(parts).toHaveLength(2);

    expect((parts[0]!.data as URL).href).toBe("https://files.slack.com/a/b/report.csv");
    expect(parts[0]?.mediaType).toBe("text/csv");
    expect(parts[0]?.filename).toBe("report.csv");

    expect((parts[1]!.data as URL).href).toBe("https://files.slack.com/a/b/cat.png");
    expect(parts[1]?.mediaType).toBe("image/png");
    expect(parts[1]?.filename).toBe("cat.png");
  });

  it("keeps audio and video attachments for the agent to open with tools", () => {
    const attachments = makeAttachments([
      { type: "audio", url: "https://files.slack.com/a/b/voice.m4a", mimeType: "audio/mp4" },
      { type: "video", url: "https://files.slack.com/a/b/clip.mp4", mimeType: "video/mp4" },
      { type: "image", url: "https://files.slack.com/a/b/cat.png", mimeType: "image/png" },
    ]);

    const parts = collectSlackFileParts(attachments, DEFAULT_UPLOAD_POLICY);

    expect(parts.map((part) => part.mediaType)).toEqual(["audio/mp4", "video/mp4", "image/png"]);
  });

  it("drops attachments missing a url (nothing for fetchFile to fetch)", () => {
    const logs = captureLogRecords();
    const attachments = makeAttachments([
      { type: "file", url: undefined, name: "ghost.csv", mimeType: "text/csv" },
      { type: "file", url: "https://files.slack.com/a/b/real.csv", mimeType: "text/csv" },
    ]);

    const parts = collectSlackFileParts(attachments, DEFAULT_UPLOAD_POLICY);

    expect(parts).toHaveLength(1);
    expect((parts[0]!.data as URL).href).toBe("https://files.slack.com/a/b/real.csv");
    expect(logs.records).toContainEqual(
      expect.objectContaining({ level: "warn", message: "dropped attachment — no url available" }),
    );
  });

  it("falls back to a generic mediaType when the attachment lacks one", () => {
    const attachments = makeAttachments([
      { type: "file", url: "https://files.slack.com/a/b/blob", name: "blob" },
    ]);

    const parts = collectSlackFileParts(attachments, DEFAULT_UPLOAD_POLICY);

    expect(parts[0]?.mediaType).toBe("application/octet-stream");
  });

  it("synthesizes a filename when none is supplied", () => {
    const attachments = makeAttachments([
      { type: "file", url: "https://files.slack.com/a/b/x.csv", mimeType: "text/csv" },
      { type: "file", url: "https://files.slack.com/a/b/y.csv", mimeType: "text/csv" },
    ]);

    const parts = collectSlackFileParts(attachments, DEFAULT_UPLOAD_POLICY);

    expect(parts[0]?.filename).toBe("attachment-0");
    expect(parts[1]?.filename).toBe("attachment-1");
  });

  it("passes all URL-backed attachments through when size is unknown at collection time", () => {
    const policy = mergeUploadPolicy({ maxBytes: 1_024 });
    const attachments = makeAttachments([
      {
        type: "file",
        url: "https://files.slack.com/a/b/huge.csv",
        mimeType: "text/csv",
        size: 4_096,
      },
      {
        type: "file",
        url: "https://files.slack.com/a/b/ok.csv",
        mimeType: "text/csv",
        size: 256,
      },
    ]);

    const parts = collectSlackFileParts(attachments, policy);

    expect(parts).toHaveLength(2);
    expect((parts[0]!.data as URL).href).toBe("https://files.slack.com/a/b/huge.csv");
    expect((parts[1]!.data as URL).href).toBe("https://files.slack.com/a/b/ok.csv");
  });

  it("drops attachments whose mediaType is not in the policy allowlist", () => {
    const logs = captureLogRecords();
    const policy = mergeUploadPolicy({ allowedMediaTypes: ["image/*"] });
    const attachments = makeAttachments([
      { type: "file", url: "https://files.slack.com/a/b/x.csv", mimeType: "text/csv" },
      { type: "image", url: "https://files.slack.com/a/b/cat.png", mimeType: "image/png" },
    ]);

    const parts = collectSlackFileParts(attachments, policy);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.mediaType).toBe("image/png");
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message:
          'dropped attachment — attachment-0 has media type "text/csv" which is not allowed by this route. Allowed: image/*.',
      }),
    );
  });

  it("returns an empty array when the message has no attachments", () => {
    expect(collectSlackFileParts([], DEFAULT_UPLOAD_POLICY)).toEqual([]);
  });
});

describe("createSlackFetchFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the upstream Slack file URL with the bot token and returns a FetchFileResult", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "image/png" },
        status: 200,
      }),
    );

    const fetchFile = createSlackFetchFile({ botToken: "xoxb-test-token" });
    const result = await fetchFile("https://files.slack.com/a/b/cat.png");

    expect(result).not.toBeNull();
    const resolved = result!;
    expect(resolved.bytes.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(resolved.mediaType).toBe("image/png");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [requestedUrl, init] = fetchSpy.mock.calls[0]!;
    expect(requestedUrl).toBe("https://files.slack.com/a/b/cat.png");
    expect((init as RequestInit | undefined)?.headers).toEqual({
      authorization: "Bearer xoxb-test-token",
    });
  });

  it("fetches Enterprise Grid Slack file URLs with the bot token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));

    const fetchFile = createSlackFetchFile({ botToken: "xoxb-test-token" });
    const url = "https://vercel.enterprise.slack.com/files/U123/F123/story.md";

    await fetchFile(url);

    expect(fetchSpy).toHaveBeenCalledWith(url, {
      headers: { authorization: "Bearer xoxb-test-token" },
      signal: expect.any(AbortSignal),
    });
  });

  it("resolves function-shaped bot tokens for the session's installation workspace", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Uint8Array([0]), { status: 200 }));

    const tokenFn = vi.fn(async (_context: { readonly teamId?: string }) => "xoxb-rotated-token");
    const fetchFile = createSlackFetchFile({ botToken: tokenFn });

    await fetchFile("https://files.slack.com/x", {
      session: { auth: { current: null, initiator: null }, id: "session-1" },
      state: { installationTeamId: "T_INSTALLATION", teamId: "T_ACTOR" },
    });

    expect(tokenFn).toHaveBeenCalledTimes(1);
    expect(tokenFn).toHaveBeenCalledWith({ teamId: "T_INSTALLATION" });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit | undefined)?.headers).toEqual({
      authorization: "Bearer xoxb-rotated-token",
    });
  });

  it.each([
    "https://example.com/not-slack.png",
    "https://files.slack.com.example.com/not-slack.png",
    "https://vercel.enterprise.slack.com.example.com/files/U123/F123/story.md",
    "http://vercel.enterprise.slack.com/files/U123/F123/story.md",
    "https://vercel.enterprise.slack.com/not-files/U123/F123/story.md",
  ])("returns null for non-Slack URL %s", async (url) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const fetchFile = createSlackFetchFile({ botToken: "xoxb-test-token" });
    const result = await fetchFile(url);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws on non-2xx responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );

    const fetchFile = createSlackFetchFile({ botToken: "xoxb-test-token" });

    const result = fetchFile("https://files.slack.com/locked.csv?sig=PRIVATE");
    await expect(result).rejects.toThrow("HTTP 403");
    await expect(result).rejects.not.toThrow("PRIVATE");
  });

  it("rejects HTML returned for a private Slack file", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<!DOCTYPE html><html><body>Slack sign in</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const fetchFile = createSlackFetchFile({ botToken: "xoxb-test-token" });

    const result = fetchFile("https://files.slack.com/locked.png?sig=PRIVATE");
    await expect(result).rejects.toThrow(/files:read.*reinstall/is);
    await expect(result).rejects.not.toThrow("PRIVATE");
  });

  const fetchFileFor = (api?: SlackTransportOptions) =>
    createSlackFetchFile({ api: resolveSlackTransportOptions(api), botToken: "xoxb-test-token" });
  const pngFetch = () =>
    vi.fn<typeof fetch>(
      async () => new Response(new Uint8Array([7]), { headers: { "content-type": "image/png" } }),
    );

  it("downloads a file under the configured file base with api.fetch", async () => {
    const globalSpy = vi.spyOn(globalThis, "fetch");
    const apiFetch = pngFetch();

    const result = await fetchFileFor({
      apiBaseUrl: "http://localhost:3000/api/slack",
      fetch: apiFetch,
      fileBaseUrl: "http://localhost:3000/files",
    })("http://localhost:3000/files/F01/cat.png");

    expect(result?.bytes.equals(Buffer.from([7]))).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith("http://localhost:3000/files/F01/cat.png", {
      headers: { authorization: "Bearer xoxb-test-token" },
      signal: expect.any(AbortSignal),
    });
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it("falls the download base back to apiBaseUrl, and widens it by path prefix only", async () => {
    const apiFetch = pngFetch();
    const underApiBase = fetchFileFor({
      apiBaseUrl: "http://localhost:3000/api/slack",
      fetch: apiFetch,
    });

    const result = await underApiBase("http://localhost:3000/api/slack/files/F01/cat.png");

    expect(result?.bytes.equals(Buffer.from([7]))).toBe(true);
    expect(await underApiBase("http://localhost:3000/files/F01/cat.png")).toBeNull();
    expect(await fetchFileFor()("http://localhost:3000/files/F01/cat.png")).toBeNull();
    // `https://slack.com/api/` is the default base: it must not turn every
    // `https://slack.com/…` link into a bot-token-authenticated download.
    expect(
      await fetchFileFor({ apiBaseUrl: "https://slack.com/api/" })(
        "https://slack.com/files/secret.png",
      ),
    ).toBeNull();
  });

  it("downloads from Slack's own file host on the global fetch, past a stand-in's api.fetch", async () => {
    const globalFetch = pngFetch();
    vi.stubGlobal("fetch", globalFetch);
    const apiFetch = pngFetch();

    const result = await fetchFileFor({
      apiBaseUrl: "http://localhost:3000/api/slack",
      fetch: apiFetch,
    })("https://files.slack.com/files-pri/T01-F01/cat.png");

    expect(result?.bytes.equals(Buffer.from([7]))).toBe(true);
    expect(globalFetch).toHaveBeenCalledWith("https://files.slack.com/files-pri/T01-F01/cat.png", {
      headers: { authorization: "Bearer xoxb-test-token" },
      signal: expect.any(AbortSignal),
    });
    // A stand-in's api.fetch attaches that stand-in's credentials, and this URL
    // arrives in an inbound payload.
    expect(apiFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("downloads from Slack's own file host on api.fetch when no base is configured", async () => {
    const globalSpy = vi.spyOn(globalThis, "fetch");
    const apiFetch = pngFetch();

    const result = await fetchFileFor({ fetch: apiFetch })(
      "https://files.slack.com/files-pri/T01-F01/cat.png",
    );

    expect(result?.bytes.equals(Buffer.from([7]))).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith("https://files.slack.com/files-pri/T01-F01/cat.png", {
      headers: { authorization: "Bearer xoxb-test-token" },
      signal: expect.any(AbortSignal),
    });
    expect(globalSpy).not.toHaveBeenCalled();
  });
});

describe("collectInboundFileParts", () => {
  const mentionWithFile = {
    attachments: makeAttachments([
      {
        type: "file",
        url: "https://files.slack.com/a/b/mention.csv",
        name: "mention.csv",
        mimeType: "text/csv",
      },
    ]),
    ts: "9.0",
  };
  const emptyMention = { attachments: [], ts: "9.0" };

  function makeSlackThread(input: {
    refresh: () => Promise<void>;
    recentMessages?: readonly {
      isMe: boolean;
      raw?: Record<string, unknown>;
      text?: string;
      ts?: string;
    }[];
  }): never {
    const messages = (input.recentMessages ?? []).map((message, index) => ({
      text: "",
      ts: `${index + 1}.0`,
      ...message,
    }));
    // The refreshed thread holds the triggering mention, as Slack returns it.
    if (messages.length > 0 && !messages.some((message) => message.ts === "9.0")) {
      messages.push({ isMe: false, raw: {}, text: "<@UBOT> what is this?", ts: "9.0" });
    }
    return { refresh: input.refresh, recentMessages: messages } as never;
  }

  function collect(
    input: Omit<Parameters<typeof collectInboundFileParts>[0], "botUserId" | "isMentioned"> &
      Partial<Parameters<typeof collectInboundFileParts>[0]>,
  ) {
    return collectInboundFileParts({ botUserId: "UBOT", isMentioned: true, ...input });
  }

  function slackFile(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      mimetype: "text/csv",
      name: `${id}.csv`,
      url_private: `https://files.slack.com/a/b/${id}.csv`,
      ...extra,
    };
  }

  it("collects files from every message since the previous mention, in thread order (#705)", async () => {
    const thread = makeSlackThread({
      refresh: vi.fn(),
      recentMessages: [
        { isMe: false, raw: { files: [slackFile("F1")] }, text: "<@UBOT> look at this" },
        { isMe: false, raw: { files: [slackFile("F2")] } },
        { isMe: false, raw: {}, text: "and here is the sheet" },
        { isMe: false, raw: { files: [slackFile("DRIVE", { mode: "external" })] } },
        { isMe: true, raw: { files: [slackFile("F3")] } },
        { isMe: false, raw: { files: [slackFile("F4")] } },
        { isMe: false, raw: {}, text: "<@UBOT> what do these say?", ts: "9.0" },
      ],
    });

    const parts = await collect({ mention: emptyMention, thread, policy: DEFAULT_UPLOAD_POLICY });

    expect(parts.map((part) => part.filename)).toEqual(["F2.csv", "F4.csv"]);
  });

  it("looks back at most 10 messages before the trigger, once per file", async () => {
    const thread = makeSlackThread({
      refresh: vi.fn(),
      recentMessages: [
        ...Array.from({ length: 12 }, (_, index) => ({
          isMe: false,
          raw: { files: [slackFile(index === 11 ? "F10" : `F${index}`)] },
          ts: `${index + 1}.0`,
        })),
        { isMe: false, raw: {}, text: "<@UBOT|eve> what are these?", ts: "20.0" },
        { isMe: false, raw: { files: [slackFile("LATER")] }, ts: "21.0" },
      ],
    });

    const parts = await collect({
      mention: { attachments: [], ts: "20.0" },
      thread,
      policy: DEFAULT_UPLOAD_POLICY,
    });

    // Messages 3-12 fall in the window; message 12 repeats F10, and the reply
    // after the trigger isn't collected.
    expect(parts.map((part) => part.filename)).toEqual(
      ["F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"].map((id) => `${id}.csv`),
    );
  });

  it("stops at a labelled mention of the app", async () => {
    const thread = makeSlackThread({
      refresh: vi.fn(),
      recentMessages: [
        { isMe: false, raw: { files: [slackFile("OLD")] } },
        { isMe: false, raw: {}, text: "<@UBOT|eve> first question" },
        { isMe: false, raw: { files: [slackFile("NEW")] } },
      ],
    });

    const parts = await collect({ mention: emptyMention, thread, policy: DEFAULT_UPLOAD_POLICY });

    expect(parts.map((part) => part.filename)).toEqual(["NEW.csv"]);
  });

  it("looks back only when the message mentions the app", async () => {
    const thread = makeSlackThread({
      refresh: vi.fn(),
      recentMessages: [{ isMe: false, raw: { files: [slackFile("F1")] } }],
    });

    const parts = await collect({
      isMentioned: false,
      mention: emptyMention,
      thread,
      policy: DEFAULT_UPLOAD_POLICY,
    });

    expect(parts).toEqual([]);
  });

  it("returns mention attachments without refreshing when present", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const thread = makeSlackThread({ refresh });

    const parts = await collect({
      mention: mentionWithFile,
      thread,
      policy: DEFAULT_UPLOAD_POLICY,
    });

    expect(parts).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reuses fetched thread messages when the mention has no attachments", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const thread = makeSlackThread({
      refresh,
      recentMessages: [
        {
          isMe: false,
          raw: {
            files: [
              {
                id: "F100",
                name: "earlier.csv",
                mimetype: "text/csv",
                url_private: "https://files.slack.com/a/b/earlier.csv",
              },
            ],
          },
        },
      ],
    });

    const parts = await collect({
      mention: emptyMention,
      thread,
      policy: DEFAULT_UPLOAD_POLICY,
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(parts).toHaveLength(1);
    expect((parts[0]!.data as URL).href).toBe("https://files.slack.com/a/b/earlier.csv");
  });

  it("skips bot-authored messages when scanning recent history", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const thread = makeSlackThread({
      refresh,
      recentMessages: [
        {
          isMe: false,
          raw: {
            files: [
              {
                id: "F200",
                mimetype: "text/csv",
                url_private: "https://files.slack.com/a/b/from-user.csv",
              },
            ],
          },
        },
        {
          isMe: true,
          raw: {
            files: [
              {
                id: "F300",
                mimetype: "text/csv",
                url_private: "https://files.slack.com/a/b/from-bot.csv",
              },
            ],
          },
        },
      ],
    });

    const parts = await collect({
      mention: emptyMention,
      thread,
      policy: DEFAULT_UPLOAD_POLICY,
    });

    expect(parts).toHaveLength(1);
    expect((parts[0]!.data as URL).href).toBe("https://files.slack.com/a/b/from-user.csv");
  });

  it.each([
    ["'disabled' literal", DISABLED_POLICY],
    ["maxBytes: 0", ZERO_BYTES_POLICY],
    ["empty allowedMediaTypes", EMPTY_MEDIA_TYPES_POLICY],
  ])("returns [] without refreshing when uploads are disabled (%s)", async (_label, policy) => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const thread = makeSlackThread({
      refresh,
      recentMessages: [
        {
          isMe: false,
          raw: {
            files: [
              {
                id: "F400",
                mimetype: "text/csv",
                url_private: "https://files.slack.com/a/b/earlier.csv",
              },
            ],
          },
        },
      ],
    });

    const parts = await collect({
      mention: emptyMention,
      thread,
      policy,
    });

    expect(parts).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("drops 'disabled'-policy inline mention attachments at the per-file check", async () => {
    const logs = captureLogRecords();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const thread = makeSlackThread({ refresh });

    const parts = await collect({
      mention: mentionWithFile,
      thread,
      policy: DISABLED_POLICY,
    });

    expect(parts).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message:
          'dropped attachment — mention.csv has media type "text/csv" which is not allowed by this route.',
      }),
    );
  });

  it("keeps inline mention attachments with maxBytes: 0 (size unknown until fetch)", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const thread = makeSlackThread({ refresh });

    const parts = await collect({
      mention: mentionWithFile,
      thread,
      policy: ZERO_BYTES_POLICY,
    });

    expect(parts).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns an empty array when refresh throws", async () => {
    const logs = captureLogRecords();
    const refresh = vi.fn().mockRejectedValue(new Error("Slack 500"));
    const thread = makeSlackThread({ refresh });

    const parts = await collect({
      mention: emptyMention,
      thread,
      policy: DEFAULT_UPLOAD_POLICY,
    });

    expect(parts).toEqual([]);
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "slack thread refresh failed for attachment collection",
      }),
    );
  });
});

describe("buildSlackTurnMessage", () => {
  it("returns the raw text string when there are no file parts", () => {
    const result = buildSlackTurnMessage("hello world", []);
    expect(result).toBe("hello world");
  });

  it("returns a UserContent array when there are file parts", () => {
    const fileParts = [
      {
        type: "file" as const,
        data: new URL("https://files.slack.com/a/b/cat.png"),
        mediaType: "image/png",
        filename: "cat.png",
      },
    ];

    const result = buildSlackTurnMessage("check this image", fileParts);

    expect(Array.isArray(result)).toBe(true);
    const content = result as Array<{ type: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "check this image" });
    expect(content[1]).toBe(fileParts[0]);
  });

  it("omits text part when text is empty", () => {
    const fileParts = [
      {
        type: "file" as const,
        data: new URL("https://files.slack.com/a/b/cat.png"),
        mediaType: "image/png",
        filename: "cat.png",
      },
    ];

    const result = buildSlackTurnMessage("", fileParts);

    expect(Array.isArray(result)).toBe(true);
    const content = result as Array<{ type: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toBe(fileParts[0]);
  });
});
