import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSlackTurnMessage,
  collectInboundFileParts,
  collectSlackFileParts,
  createSlackFetchFile,
} from "#public/channels/slack/attachments.js";
import type { SlackAttachment } from "#public/channels/slack/inbound.js";
import { DEFAULT_UPLOAD_POLICY, mergeUploadPolicy } from "#public/channels/upload-policy.js";

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

  it("skips audio and video attachments", () => {
    const attachments = makeAttachments([
      { type: "audio", url: "https://files.slack.com/a/b/voice.m4a", mimeType: "audio/mp4" },
      { type: "video", url: "https://files.slack.com/a/b/clip.mp4", mimeType: "video/mp4" },
      { type: "image", url: "https://files.slack.com/a/b/cat.png", mimeType: "image/png" },
    ]);

    const parts = collectSlackFileParts(attachments, DEFAULT_UPLOAD_POLICY);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.mediaType).toBe("image/png");
  });

  it("drops attachments missing a url (nothing for fetchFile to fetch)", () => {
    const attachments = makeAttachments([
      { type: "file", url: undefined, name: "ghost.csv", mimeType: "text/csv" },
      { type: "file", url: "https://files.slack.com/a/b/real.csv", mimeType: "text/csv" },
    ]);

    const parts = collectSlackFileParts(attachments, DEFAULT_UPLOAD_POLICY);

    expect(parts).toHaveLength(1);
    expect((parts[0]!.data as URL).href).toBe("https://files.slack.com/a/b/real.csv");
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
    const policy = mergeUploadPolicy({ allowedMediaTypes: ["image/*"] });
    const attachments = makeAttachments([
      { type: "file", url: "https://files.slack.com/a/b/x.csv", mimeType: "text/csv" },
      { type: "image", url: "https://files.slack.com/a/b/cat.png", mimeType: "image/png" },
    ]);

    const parts = collectSlackFileParts(attachments, policy);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.mediaType).toBe("image/png");
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
    });
  });

  it("invokes a function-shaped bot token to support rotation", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Uint8Array([0]), { status: 200 }));

    const tokenFn = vi.fn(async () => "xoxb-rotated-token");
    const fetchFile = createSlackFetchFile({ botToken: tokenFn });

    await fetchFile("https://files.slack.com/x");

    expect(tokenFn).toHaveBeenCalledTimes(1);
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

    await expect(fetchFile("https://files.slack.com/locked.csv")).rejects.toThrow("HTTP 403");
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
  };
  const emptyMention = { attachments: [] };

  function makeSlackThread(input: {
    refresh: () => Promise<void>;
    recentMessages?: readonly { isMe: boolean; raw?: Record<string, unknown> }[];
  }): never {
    return {
      refresh: input.refresh,
      recentMessages: input.recentMessages ?? [],
    } as never;
  }

  it("returns mention attachments without refreshing when present", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const thread = makeSlackThread({ refresh });

    const parts = await collectInboundFileParts({
      mention: mentionWithFile,
      thread,
      policy: DEFAULT_UPLOAD_POLICY,
    });

    expect(parts).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("falls back to the latest non-bot thread message when the mention has no attachments", async () => {
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

    const parts = await collectInboundFileParts({
      mention: emptyMention,
      thread,
      policy: DEFAULT_UPLOAD_POLICY,
    });

    expect(refresh).toHaveBeenCalledOnce();
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

    const parts = await collectInboundFileParts({
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

    const parts = await collectInboundFileParts({
      mention: emptyMention,
      thread,
      policy,
    });

    expect(parts).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("drops 'disabled'-policy inline mention attachments at the per-file check", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const thread = makeSlackThread({ refresh });

    const parts = await collectInboundFileParts({
      mention: mentionWithFile,
      thread,
      policy: DISABLED_POLICY,
    });

    expect(parts).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps inline mention attachments with maxBytes: 0 (size unknown until fetch)", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const thread = makeSlackThread({ refresh });

    const parts = await collectInboundFileParts({
      mention: mentionWithFile,
      thread,
      policy: ZERO_BYTES_POLICY,
    });

    expect(parts).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns an empty array when refresh throws", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("Slack 500"));
    const thread = makeSlackThread({ refresh });

    const parts = await collectInboundFileParts({
      mention: emptyMention,
      thread,
      policy: DEFAULT_UPLOAD_POLICY,
    });

    expect(parts).toEqual([]);
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
