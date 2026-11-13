import type { LinqChannelConfig } from "eve/channels/linq";
import type { CallSettled, InteractionOpened, JsonValue } from "eve/events";
import {
  createLinqAdapter,
  type LinqSendOptions,
} from "@linqapp/chat-sdk-adapter";
import type { LinqAPIV3 } from "@linqapp/sdk";
import type { AdapterPostableMessage } from "chat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Blob from "@vercel/blob";
import type * as EnvModule from "@shared/environment";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { viewOf } from "@tests/helpers/session-view";
import type { AccessScope } from "@shared/identity/access-scope";
import type {
  finalizeScheduledReport,
  releaseScheduledReport,
} from "@db/services/scheduled-agent-jobs";
// oxlint-disable-next-line import/no-unassigned-import -- Loads the production module so the mocked channel factory can capture its configuration.
import "@agent/channels/linq";

interface BrowserImage {
  bytes: Uint8Array;
  filename: string;
  id: string;
  mediaType: string;
}

type NativeMessageBody = Parameters<LinqAPIV3["chats"]["messages"]["send"]>[1];
type NativeMessageOptions = Parameters<
  LinqAPIV3["chats"]["messages"]["send"]
>[2];

const rawMessage = (id: string) => ({ id });
const linqChannelCapture = vi.hoisted(() => ({
  // SAFETY: This mutable test capture stores only API keys from the typed SDK constructor mock.
  clientApiKeys: [] as string[],
  // SAFETY: The mocked channel factory replaces this value during module loading.
  config: undefined as LinqChannelConfig | undefined,
  images: new Map<string, BrowserImage>(),
  readImage: vi.fn<
    (
      scope: AccessScope,
      id: string,
      options: {
        readonly rootSessionId: string;
        readonly signal?: AbortSignal;
      }
    ) => Promise<BrowserImage | undefined>
  >(),
  postMessage: vi
    .fn<
      (
        threadId: string,
        message: AdapterPostableMessage,
        options?: LinqSendOptions
      ) => Promise<{ id: string }>
    >()
    .mockResolvedValue({ id: "scheduled-message-1" }),
  resolveApiKey: vi
    .fn<() => Promise<string>>()
    .mockResolvedValue("linq-test-api-key"),
  sendNativeMessage: vi
    .fn<
      (
        chatId: string,
        body: NativeMessageBody,
        options?: NativeMessageOptions
      ) => Promise<{ message: { id: string } }>
    >()
    .mockResolvedValue({ message: { id: "native-message-1" } }),
}));
const scheduleDeliveryCapture = vi.hoisted(() => ({
  finalize: vi.fn<typeof finalizeScheduledReport>(),
  release: vi.fn<typeof releaseScheduledReport>(),
}));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  finalizeScheduledReport: scheduleDeliveryCapture.finalize,
  releaseScheduledReport: scheduleDeliveryCapture.release,
}));
vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: { ...original.env, LINQ_CONNECTOR: "linq/test" },
  };
});
vi.mock("@vercel/connect/eve", () => ({
  connectLinqCredentials: () => ({
    apiKey: linqChannelCapture.resolveApiKey,
  }),
}));
vi.mock("@linqapp/sdk", () => ({
  LinqAPIV3: class {
    constructor(options: Pick<LinqAPIV3, "apiKey">) {
      linqChannelCapture.clientApiKeys.push(options.apiKey);
    }

    chats = {
      messages: { send: linqChannelCapture.sendNativeMessage },
    };
  },
}));
vi.mock(import("eve/channels/linq"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    linqChannel(config: LinqChannelConfig) {
      linqChannelCapture.config = config;
      return original.linqChannel(config);
    },
  };
});
vi.mock("@db/services/browser-images", () => ({
  async readReadyBrowserImageArtifact(
    scope: AccessScope,
    id: string,
    options: { readonly rootSessionId: string; readonly signal?: AbortSignal }
  ) {
    const image = await linqChannelCapture.readImage(scope, id, options);
    if (!image) return undefined;
    linqChannelCapture.images.set(id, image);
    return {
      byteSize: image.bytes.byteLength,
      contentHash:
        image.bytes[0] === 1
          ? "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
          : "787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
      filename: image.filename,
      id,
      mediaType: image.mediaType,
      storagePathname: id,
    };
  },
}));
vi.mock("@vercel/blob", async (importOriginal) => {
  const blob = await importOriginal<typeof Blob>();
  return {
    ...blob,
    async get(pathname: string) {
      const image = linqChannelCapture.images.get(pathname);
      if (!image) return null;
      return {
        blob: { contentType: image.mediaType, size: image.bytes.byteLength },
        statusCode: 200,
        stream: new Response(Buffer.from(image.bytes)).body,
      };
    },
  };
});
const configuredCallSettled =
  linqChannelCapture.config?.events?.["call.settled"];
if (!configuredCallSettled) {
  throw new Error("The Linq channel must configure call result delivery.");
}
const handleCallSettled = configuredCallSettled;
const configuredInteractionOpened =
  linqChannelCapture.config?.events?.["interaction.opened"];
if (!configuredInteractionOpened) {
  throw new Error("The Linq channel must configure sign-in delivery.");
}
const handleInteractionOpened = configuredInteractionOpened;

type CallHandlerContext = Parameters<typeof handleCallSettled>[1];
type LinqEventChannel = CallHandlerContext["channel"];
type LinqSessionContext = Omit<
  CallHandlerContext,
  "channel" | "position" | "view"
>;

interface SettledToolCall {
  readonly event: CallSettled;
  readonly view: CallHandlerContext["view"];
}

/** Delivers a settled call the way eve does: the view names the call's tool. */
function handleActionResult(
  result: SettledToolCall,
  channel: LinqEventChannel,
  session: LinqSessionContext
) {
  return handleCallSettled(result.event, {
    ...session,
    channel,
    position: { index: 0, line: 3 },
    view: result.view,
  });
}

function handleAuthorizationRequired(
  event: InteractionOpened,
  channel: LinqEventChannel,
  session: LinqSessionContext
) {
  return handleInteractionOpened(event, {
    ...session,
    channel,
    position: { index: 0, line: 3 },
    view: viewOf([]),
  });
}

interface LinqTestMessage {
  readonly attachments?: readonly {
    readonly mimeType?: string;
    readonly name?: string;
    readonly type: "audio" | "file" | "image" | "video";
    readonly url: string;
  }[];
  readonly files?: readonly {
    readonly data: Buffer;
    readonly filename: string;
    readonly mimeType: string;
  }[];
  readonly text: string;
}

describe("Linq message delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    linqChannelCapture.sendNativeMessage
      .mockReset()
      .mockImplementation(async (_chatId, body) => {
        const parts = body.message.parts ?? [];
        if (parts.some((part) => part.type === "link") && parts.length !== 1)
          throw new Error("400 link part must be the only part in the message");
        return {
          message: {
            id:
              parts[0]?.type === "link"
                ? "native-link-message"
                : "native-text-message",
          },
        };
      });
    scheduleDeliveryCapture.finalize.mockResolvedValue(true);
    scheduleDeliveryCapture.release.mockResolvedValue(true);
  });

  it("does not register automatic assistant text posting", () => {
    expect(linqChannelCapture.config?.events?.["content.completed"]).toBeTypeOf(
      "function"
    );
  });

  it("posts send_message output as raw iMessage text", async () => {
    const message = [
      "Still blocked. No order was submitted.",
      "The order remains unchanged:",
      "Spider-Man: Brand New Day",
      "$15.00 total",
    ].join("\n");
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "message", text: message }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({ raw: message });
  });

  it("does not resend share_contact output from the channel event", async () => {
    const event = settledToolCall("share_contact", {
      kind: "message",
      text: "Save my contact.",
      attachments: [
        {
          kind: "file",
          url: "https://example.com/contacts/openinstinct.vcf?signed=true",
        },
      ],
    });
    const { context, post } = handlerContext();
    await handleActionResult(event, context, sessionContext());
    expect(post).not.toHaveBeenCalled();
    expect(linqChannelCapture.postMessage).not.toHaveBeenCalled();
    expect(linqChannelCapture.sendNativeMessage).not.toHaveBeenCalled();
  });

  it("delivers authorization text and its native link as separate messages accepted by Linq", async () => {
    const { context, post } = handlerContext();
    const event = authorizationEvent();
    await handleAuthorizationRequired(event, context, sessionContext());

    expect(linqChannelCapture.sendNativeMessage).toHaveBeenCalledTimes(2);
    expect(linqChannelCapture.sendNativeMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      {
        message: {
          idempotency_key: "authorization:session-1:sign-in-1:prompt",
          parts: [
            {
              type: "text",
              value:
                "Connect your Link wallet to continue.\n\nPurchases require separate approval.",
            },
          ],
        },
      },
      undefined
    );
    expect(linqChannelCapture.sendNativeMessage).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      {
        message: {
          idempotency_key: "authorization:session-1:sign-in-1:link",
          parts: [
            {
              type: "link",
              value:
                "https://example.com/api/link?attempt=00000000-0000-4000-8000-000000000001",
            },
          ],
        },
      },
      undefined
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("reuses the provider idempotency key when an authorization event is replayed", async () => {
    const { context } = handlerContext();
    const event = authorizationEvent();
    await handleAuthorizationRequired(event, context, sessionContext());
    await handleAuthorizationRequired(event, context, sessionContext());
    expect(
      linqChannelCapture.sendNativeMessage.mock.calls.map(
        ([, body]) => body.message.idempotency_key
      )
    ).toEqual([
      "authorization:session-1:sign-in-1:prompt",
      "authorization:session-1:sign-in-1:link",
      "authorization:session-1:sign-in-1:prompt",
      "authorization:session-1:sign-in-1:link",
    ]);
  });

  it("delivers Link purchase approval URLs unchanged as native links", async () => {
    const { context, post } = handlerContext();
    const approvalUrl =
      "https://app.link.com/approve/spr_1?approval_token=opaque%2Btoken&source=agent";
    await handleActionResult(
      sendMessageResult({ kind: "link", url: approvalUrl }),
      context,
      sessionContext()
    );
    expect(
      linqChannelCapture.sendNativeMessage
    ).toHaveBeenCalledExactlyOnceWith(
      "chat-1",
      {
        message: { parts: [{ type: "link", value: approvalUrl }] },
      },
      undefined
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps delegated authorization challenges out of the root conversation", async () => {
    const { context, post } = handlerContext();
    await handleAuthorizationRequired(
      authorizationEvent({
        interactionId: "worker-sign-in",
        sessionId: "worker-session",
      }),
      context,
      sessionContext()
    );
    expect(linqChannelCapture.sendNativeMessage).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("sends a native reply to the current inbound message", async () => {
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        replyTo: { kind: "current" },
        text: "Yes, that one.",
      }),
      context,
      sessionContext("test", undefined, "message-to-reply-to")
    );

    expect(linqChannelCapture.postMessage).toHaveBeenCalledExactlyOnceWith(
      "linq:dm:chat-1",
      { raw: "Yes, that one." },
      { replyToMessageId: "message-to-reply-to" }
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("sends an attachment-only native reply", async () => {
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [
          {
            kind: "image",
            mimeType: "image/png",
            name: "result.png",
            url: "https://media.example/result.png",
          },
        ],
        kind: "message",
        replyTo: { kind: "current" },
      }),
      context,
      sessionContext("test", undefined, "message-to-reply-to")
    );

    expect(linqChannelCapture.postMessage).toHaveBeenCalledExactlyOnceWith(
      "linq:dm:chat-1",
      {
        attachments: [
          {
            mimeType: "image/png",
            name: "result.png",
            type: "image",
            url: "https://media.example/result.png",
          },
        ],
        raw: "",
      },
      { replyToMessageId: "message-to-reply-to" }
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("passes media and a reply target through the Linq adapter", async () => {
    const nativeFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          chat_id: "chat-1",
          message: { id: "native-message-1" },
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      )
    );
    const adapter = createLinqAdapter({
      apiKey: "linq-test-api-key",
      baseURL: "https://linq.test",
      signingSecret: "linq-test-signing-secret",
    });
    let body: unknown;

    try {
      await adapter.postMessage(
        adapter.encodeThreadId({ chatId: "chat-1" }),
        {
          attachments: [
            { type: "image", url: "https://media.example/result.png" },
          ],
          raw: "Here it is.",
        },
        {
          idempotencyKey: "reply-with-media",
          replyToMessageId: "message-to-reply-to",
        }
      );
      expect(nativeFetch).toHaveBeenCalledOnce();
      const [input, init] = nativeFetch.mock.calls[0] ?? [];
      body = await (
        input instanceof Request ? input.clone() : new Response(init?.body)
      ).json();
    } finally {
      nativeFetch.mockRestore();
    }

    expect(body).toEqual({
      message: {
        idempotency_key: "reply-with-media",
        parts: [
          { type: "text", value: "Here it is." },
          { type: "media", url: "https://media.example/result.png" },
        ],
        reply_to: { message_id: "message-to-reply-to" },
      },
    });
  });

  it("falls back to a normal message when a reply handle is unavailable", async () => {
    const { context, post } = handlerContext(null);

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        replyTo: { kind: "current" },
        text: "Yes, that one.",
      }),
      context,
      sessionContext("test", undefined, null)
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({ raw: "Yes, that one." });
  });

  it("finalizes a scheduled result after send_message posts it", async () => {
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "message", text: "The price fell." }),
      context,
      sessionContext("scheduled-result")
    );

    expect(scheduleDeliveryCapture.finalize).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000004",
      "delivered"
    );
    expect(linqChannelCapture.postMessage).toHaveBeenCalledExactlyOnceWith(
      "linq:dm:chat-1",
      { raw: "The price fell." },
      {
        idempotencyKey:
          "scheduled-report:00000000-0000-4000-8000-000000000002:1",
      }
    );
  });

  it("replies scheduled results to their initiating message", async () => {
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        replyTo: {
          id: "00000000-0000-4000-8000-000000000003",
          kind: "automation",
        },
        text: "Time to renew it.",
      }),
      context,
      sessionContext("scheduled-result", "original-message")
    );

    expect(linqChannelCapture.postMessage).toHaveBeenCalledExactlyOnceWith(
      "linq:dm:chat-1",
      { raw: "Time to renew it." },
      {
        idempotencyKey:
          "scheduled-report:00000000-0000-4000-8000-000000000002:1",
        replyToMessageId: "original-message",
      }
    );
  });

  it("keeps scheduled native link replies idempotent", async () => {
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "link",
        replyTo: {
          id: "00000000-0000-4000-8000-000000000003",
          kind: "automation",
        },
        url: "https://example.com/renew",
      }),
      context,
      sessionContext("scheduled-result", "original-message")
    );

    expect(linqChannelCapture.sendNativeMessage).toHaveBeenCalledWith(
      "chat-1",
      {
        message: {
          idempotency_key:
            "scheduled-report:00000000-0000-4000-8000-000000000002:1",
          parts: [{ type: "link", value: "https://example.com/renew" }],
          reply_to: { message_id: "original-message" },
        },
      },
      undefined
    );
  });

  it("falls back without changing an automation anchor when the old target is unavailable", async () => {
    linqChannelCapture.postMessage.mockRejectedValueOnce({ status: 404 });
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        replyTo: {
          id: "00000000-0000-4000-8000-000000000003",
          kind: "automation",
        },
        text: "Time to renew it.",
      }),
      context,
      sessionContext("scheduled-result", "expired-message")
    );

    expect(linqChannelCapture.postMessage).toHaveBeenCalledTimes(2);
    expect(linqChannelCapture.postMessage).toHaveBeenNthCalledWith(
      1,
      "linq:dm:chat-1",
      { raw: "Time to renew it." },
      {
        idempotencyKey:
          "scheduled-report:00000000-0000-4000-8000-000000000002:1",
        replyToMessageId: "expired-message",
      }
    );
    expect(linqChannelCapture.postMessage).toHaveBeenNthCalledWith(
      2,
      "linq:dm:chat-1",
      { raw: "Time to renew it." },
      {
        idempotencyKey:
          "scheduled-report:00000000-0000-4000-8000-000000000002:1",
      }
    );
  });

  it("uses the same Linq idempotency key when a report turn is retried", async () => {
    const { context } = handlerContext();
    const event = sendMessageResult({
      kind: "message",
      text: "The price fell.",
    });

    await handleActionResult(
      event,
      context,
      sessionContext("scheduled-result")
    );
    await handleActionResult(
      event,
      context,
      sessionContext("scheduled-result")
    );

    expect(linqChannelCapture.postMessage).toHaveBeenCalledTimes(2);
    expect(linqChannelCapture.postMessage.mock.calls[0]?.[2]).toEqual(
      linqChannelCapture.postMessage.mock.calls[1]?.[2]
    );
  });

  it("posts one native rich link preview per call with fresh credentials", async () => {
    const { context, post } = handlerContext();
    linqChannelCapture.clientApiKeys.length = 0;
    linqChannelCapture.resolveApiKey
      .mockResolvedValueOnce("linq-api-key-1")
      .mockResolvedValueOnce("linq-api-key-2");

    await handleActionResult(
      sendMessageResult({ kind: "link", url: "https://example.com/first" }),
      context,
      sessionContext()
    );
    await handleActionResult(
      sendMessageResult({ kind: "link", url: "https://example.com/second" }),
      context,
      sessionContext()
    );

    expect(linqChannelCapture.resolveApiKey).toHaveBeenCalledTimes(2);
    expect(linqChannelCapture.clientApiKeys).toEqual([
      "linq-api-key-1",
      "linq-api-key-2",
    ]);
    expect(linqChannelCapture.sendNativeMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      {
        message: {
          parts: [{ type: "link", value: "https://example.com/first" }],
        },
      },
      undefined
    );
    expect(linqChannelCapture.sendNativeMessage).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      {
        message: {
          parts: [{ type: "link", value: "https://example.com/second" }],
        },
      },
      undefined
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("requires a native link preview to be its own send_message call", () => {
    expect(
      sendMessageOutputSchema.safeParse({
        kind: "link",
        text: "Read this",
        url: "https://example.com/article",
      }).success
    ).toBe(false);
  });

  it("accepts typed reply handles for text, attachments, and native links", () => {
    expect(
      sendMessageOutputSchema.safeParse({
        kind: "message",
        replyTo: { kind: "current" },
        text: "This one.",
      }).success
    ).toBe(true);
    expect(
      sendMessageOutputSchema.safeParse({
        kind: "message",
        replyTo: { id: "task-1", kind: "task" },
        text: "This one.",
      }).success
    ).toBe(true);
    expect(
      sendMessageOutputSchema.safeParse({
        kind: "link",
        replyTo: {
          id: "00000000-0000-4000-8000-000000000003",
          kind: "automation",
        },
        url: "https://example.com",
      }).success
    ).toBe(true);
    expect(
      sendMessageOutputSchema.safeParse({
        attachments: [{ kind: "image", url: "https://example.com/image.png" }],
        kind: "message",
        replyTo: { kind: "current" },
        text: "This one.",
      }).success
    ).toBe(true);
  });

  it("discriminates native links from message content", () => {
    expect(
      sendMessageOutputSchema.safeParse({
        attachments: [{ kind: "image", url: "https://example.com/image.png" }],
        kind: "message",
        text: "A caption",
      }).success
    ).toBe(true);
    expect(sendMessageOutputSchema.safeParse({ kind: "message" }).success).toBe(
      false
    );
    expect(
      sendMessageOutputSchema.safeParse({
        kind: "message",
        text: "Read this",
        url: "https://example.com/article",
      }).success
    ).toBe(false);
    expect(
      sendMessageOutputSchema.safeParse({
        link: "https://example.com/article",
      }).success
    ).toBe(false);
  });

  it("enforces Linq's native link URL constraints", () => {
    const prefix = "https://example.com/";
    const maximumLengthLink = `${prefix}${"a".repeat(2048 - prefix.length)}`;

    expect(
      sendMessageOutputSchema.safeParse({
        kind: "link",
        url: maximumLengthLink,
      }).success
    ).toBe(true);
    expect(
      sendMessageOutputSchema.safeParse({
        kind: "link",
        url: `${maximumLengthLink}a`,
      }).success
    ).toBe(false);
    expect(
      sendMessageOutputSchema.safeParse({
        kind: "link",
        url: "http://example.com/article",
      }).success
    ).toBe(false);
  });

  it("posts a proactive message without a current inbound message", async () => {
    const { context, post } = handlerContext(null);

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: "Your weekly summary is ready.",
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      raw: "Your weekly summary is ready.",
    });
  });

  it.each([
    ["image", "image/jpeg", "photo.jpg"],
    ["video", "video/mp4", "clip.mp4"],
    ["audio", "audio/mpeg", "voice.mp3"],
    ["file", "application/pdf", "brief.pdf"],
  ] as const)("posts a native %s attachment", async (kind, mimeType, name) => {
    const { context, post } = handlerContext();
    const url = `https://media.example/${name}`;

    await handleActionResult(
      sendMessageResult({
        attachments: [{ kind, mimeType, name, url }],
        kind: "message",
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      attachments: [{ mimeType, name, type: kind, url }],
      raw: "",
    });
  });

  it("threads scoped artifact files as a native reply", async () => {
    const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    linqChannelCapture.readImage.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "product.png",
      id: artifactId,
      mediaType: "image/png",
    });
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        replyTo: { kind: "current" },
        text: `Here it is.\n\n![Product](/artifacts/${artifactId})`,
      }),
      context,
      sessionContext()
    );

    expect(linqChannelCapture.readImage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workspaceId: "workspace-1",
      }),
      artifactId,
      { rootSessionId: "session-1", signal: undefined }
    );
    expect(linqChannelCapture.postMessage).toHaveBeenCalledExactlyOnceWith(
      "linq:dm:chat-1",
      {
        files: [
          {
            data: Buffer.from([1, 2, 3]),
            filename: "product.png",
            mimeType: "image/png",
          },
        ],
        raw: "Here it is.",
      },
      { replyToMessageId: "message-1" }
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("threads scheduled artifacts from the scheduled-run session", async () => {
    const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    linqChannelCapture.readImage.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "scheduled-product.png",
      id: artifactId,
      mediaType: "image/png",
    });
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        replyTo: {
          id: "00000000-0000-4000-8000-000000000003",
          kind: "automation",
        },
        text: `Price changed.\n\n![Product](/artifacts/${artifactId})`,
      }),
      context,
      sessionContext("scheduled-result", "original-message")
    );

    expect(linqChannelCapture.readImage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workspaceId: "workspace-1",
      }),
      artifactId,
      { rootSessionId: "scheduled-run-session", signal: undefined }
    );
    expect(linqChannelCapture.postMessage).toHaveBeenCalledWith(
      "linq:dm:chat-1",
      expect.objectContaining({
        files: [expect.objectContaining({ filename: "scheduled-product.png" })],
        raw: "Price changed.",
      }),
      expect.objectContaining({
        idempotencyKey:
          "scheduled-report:00000000-0000-4000-8000-000000000002:1",
        replyToMessageId: "original-message",
      })
    );
  });

  it("sends multiple artifact images as one native attachment gallery", async () => {
    const firstArtifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    const secondArtifactId = "206c3a7e-c0b8-4317-9e34-552cff646673";
    linqChannelCapture.readImage.mockImplementation(
      async (_scope, artifactId) => ({
        bytes: new Uint8Array(
          artifactId === firstArtifactId ? [1, 2, 3] : [4, 5, 6]
        ),
        filename: artifactId === firstArtifactId ? "first.png" : "second.png",
        id: artifactId,
        mediaType: "image/png",
      })
    );
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: [
          "Two good options.",
          `![First](/artifacts/${firstArtifactId})`,
          `![Second](/artifacts/${secondArtifactId})`,
        ].join("\n"),
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      files: [
        {
          data: Buffer.from([1, 2, 3]),
          filename: "first.png",
          mimeType: "image/png",
        },
        {
          data: Buffer.from([4, 5, 6]),
          filename: "second.png",
          mimeType: "image/png",
        },
      ],
      raw: "Two good options.",
    });
  });

  it("keeps one send_message call in one bubble with its images", async () => {
    const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    linqChannelCapture.readImage.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "product.png",
      id: artifactId,
      mediaType: "image/png",
    });
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: `First thought.\n\nSecond thought.\n\n![Product](/artifacts/${artifactId})`,
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      files: [
        {
          data: Buffer.from([1, 2, 3]),
          filename: "product.png",
          mimeType: "image/png",
        },
      ],
      raw: "First thought.\n\nSecond thought.",
    });
  });

  it.each([
    "thumbs_up",
    "thumbs_down",
    "heart",
    "laugh",
    "exclamation",
    "question",
  ] as const)("adds the native %s Tapback", async (type) => {
    const { addReaction, context, post } = handlerContext();

    await handleActionResult(
      reactToMessageResult({ operation: "add", type }),
      context,
      sessionContext()
    );

    expect(addReaction).toHaveBeenCalledExactlyOnceWith(
      "linq:dm:chat-1",
      "message-1",
      type
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("removes a native Tapback", async () => {
    const { context, post, removeReaction } = handlerContext();

    await handleActionResult(
      reactToMessageResult({ operation: "remove", type: "heart" }),
      context,
      sessionContext()
    );

    expect(removeReaction).toHaveBeenCalledExactlyOnceWith(
      "linq:dm:chat-1",
      "message-1",
      "heart"
    );
    expect(post).not.toHaveBeenCalled();
  });

  it.each(["add", "remove"] as const)(
    "%s targets the incoming message when the thread snapshot is stale",
    async (operation) => {
      const { addReaction, context, removeReaction } =
        handlerContext("first-message");

      await handleActionResult(
        reactToMessageResult({ operation, type: "thumbs_up" }),
        context,
        sessionContext("linq-message", undefined, "latest-message")
      );

      const deliver = operation === "add" ? addReaction : removeReaction;
      const unused = operation === "add" ? removeReaction : addReaction;
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        "linq:dm:chat-1",
        "latest-message",
        "thumbs_up"
      );
      expect(unused).not.toHaveBeenCalled();
    }
  );

  it("reacts to the incoming message without a cached current message", async () => {
    const { addReaction, context } = handlerContext(null);

    await handleActionResult(
      reactToMessageResult({ operation: "add", type: "thumbs_up" }),
      context,
      sessionContext()
    );

    expect(addReaction).toHaveBeenCalledExactlyOnceWith(
      "linq:dm:chat-1",
      "message-1",
      "thumbs_up"
    );
  });

  it("does not react to a cached message without an incoming message ID", async () => {
    const { addReaction, context, removeReaction } = handlerContext();

    await expect(
      handleActionResult(
        reactToMessageResult({ operation: "add", type: "thumbs_up" }),
        context,
        sessionContext("linq-message", undefined, null)
      )
    ).rejects.toThrow("react_to_message requires a current Linq message.");

    expect(addReaction).not.toHaveBeenCalled();
    expect(removeReaction).not.toHaveBeenCalled();
  });

  it("rejects an incoming reaction target from a different conversation", async () => {
    const { addReaction, context, removeReaction } = handlerContext();
    const session = sessionContext();
    session.session.auth.current.attributes.conversationId = "linq:other-chat";

    await expect(
      handleActionResult(
        reactToMessageResult({ operation: "add", type: "thumbs_up" }),
        context,
        session
      )
    ).rejects.toThrow("react_to_message requires a current Linq message.");

    expect(addReaction).not.toHaveBeenCalled();
    expect(removeReaction).not.toHaveBeenCalled();
  });
});

function settledToolCall(toolName: string, output: JsonValue): SettledToolCall {
  const callId = `call-${toolName}`;
  return {
    event: {
      data: { callId, outcome: "completed", output },
      scope: { runId: "run-1", turnId: "turn-1" },
      type: "call.settled",
    },
    view: viewOf([
      [
        {
          data: {
            cause: { deliveryId: "delivery-1" },
            follows: null,
            turnId: "turn-1",
          },
          type: "turn.started",
        },
      ],
      [
        {
          data: {
            callId,
            capability: { kind: "tool", name: toolName },
            input: output,
            owner: { runId: "run-1" },
          },
          scope: { runId: "run-1", turnId: "turn-1" },
          type: "call.requested",
        },
      ],
    ]),
  };
}

function sendMessageResult(output: JsonValue) {
  return settledToolCall("send_message", output);
}

function reactToMessageResult(output: JsonValue) {
  return settledToolCall("react_to_message", output);
}

function handlerContext(currentMessageId: string | null = "message-1") {
  const post = vi.fn<(message: LinqTestMessage) => Promise<{ id: string }>>();
  post.mockResolvedValue(rawMessage("message-2"));
  const addReaction = vi
    .fn<(threadId: string, messageId: string, emoji: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const removeReaction = vi
    .fn<(threadId: string, messageId: string, emoji: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const context = handlerEventContext({
    bot: {
      getAdapter: () => ({
        addReaction,
        decodeThreadId: () => ({ chatId: "chat-1", isGroup: false }),
        postMessage: linqChannelCapture.postMessage,
        removeReaction,
      }),
    },
    state: {},
    streaming: false,
    streamingEditIntervalMs: 1000,
    thread: {
      id: "linq:dm:chat-1",
      isDM: true,
      post,
      toJSON: () => ({
        _type: "chat:Thread",
        adapterName: "linq",
        channelId: "linq:dm:chat-1",
        currentMessage: currentMessageId ? { id: currentMessageId } : undefined,
        id: "linq:dm:chat-1",
        isDM: true,
      }),
    },
  });

  return {
    addReaction,
    context,
    post,
    removeReaction,
  };
}

function authorizationEvent(
  origin?: Readonly<{ interactionId: string; sessionId: string }>
): InteractionOpened {
  return {
    data: {
      interactionId: "sign-in-1",
      origin,
      request: {
        kind: "sign-in",
        prompt: "Authorization required for Link wallet",
        signIn: {
          displayName: "Link wallet",
          instructions:
            "Connect your Link wallet to continue.\n\nPurchases require separate approval.",
          name: "link",
          url: "https://example.com/api/link?attempt=00000000-0000-4000-8000-000000000001",
        },
      },
      subject: { turnId: "turn-1" },
    },
    scope: { turnId: "turn-1" },
    type: "interaction.opened",
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This test adapter deliberately accepts a focused structural fixture.
function handlerEventContext(value: unknown): LinqEventChannel {
  // SAFETY: Callers provide every Linq context field exercised by these focused handlers.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete Chat SDK bot mock would add 97 unrelated methods.
  return value as LinqEventChannel;
}

function sessionContext(
  authenticator = "test",
  replyAnchorMessageId?: string,
  currentMessageId: string | null = "message-1"
) {
  const attributes: Record<string, string | readonly string[]> =
    authenticator === "scheduled-result"
      ? {
          conversationChannel: "linq",
          conversationId: "linq:dm:chat-1",
          scheduleId: "00000000-0000-4000-8000-000000000003",
          scheduledReportLeaseToken: "00000000-0000-4000-8000-000000000004",
          scheduledReportSequence: "1",
          scheduledRunId: "00000000-0000-4000-8000-000000000002",
          scheduledRunSessionId: "scheduled-run-session",
          workspaceId: "workspace-1",
        }
      : {
          conversationChannel: "linq",
          conversationId: "linq:dm:chat-1",
          workspaceId: "workspace-1",
        };
  if (authenticator !== "scheduled-result" && currentMessageId) {
    attributes.linqMessageId = currentMessageId;
  }
  if (replyAnchorMessageId) {
    attributes.linqReplyAnchorMessageId = replyAnchorMessageId;
  }
  return {
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes,
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
  } satisfies LinqSessionContext;
}
