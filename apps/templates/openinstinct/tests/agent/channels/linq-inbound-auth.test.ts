import type { LinqChannelConfig } from "eve/channels/linq";
import { Message } from "chat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@shared/environment";
// oxlint-disable-next-line import/no-unassigned-import -- Loads the production module so the mocked channel factory can capture its configuration.
import "@agent/channels/linq";

interface AuthUserRow {
  readonly id: string;
  readonly phoneNumberVerified: boolean;
}

const capture = vi.hoisted(() => ({
  // SAFETY: The mocked channel factory replaces this value during module loading.
  config: undefined as LinqChannelConfig | undefined,
  findOne: vi.fn<() => Promise<AuthUserRow | null>>(),
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: { ...original.env, LINQ_CONNECTOR: "linq/test" },
  };
});
vi.mock("@vercel/connect/eve", () => ({
  connectLinqCredentials: () => ({ apiKey: async () => "linq-test-api-key" }),
}));
vi.mock(import("eve/channels/linq"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    linqChannel(config: LinqChannelConfig) {
      capture.config = config;
      return original.linqChannel(config);
    },
  };
});
vi.mock("@db/services/auth", () => ({
  getAuth: async () => ({
    $context: Promise.resolve({ adapter: { findOne: capture.findOne } }),
  }),
}));

const verifier = capture.config?.credentials?.webhookVerifier;
const onMessage = capture.config?.onMessage;
if (!verifier || !onMessage) {
  throw new Error("The Linq channel must verify webhooks and route messages.");
}

describe("Linq inbound authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a webhook without a forwarder credential", async () => {
    const request = new Request("https://assistant.example/eve/v1/linq", {
      body: "{}",
      method: "POST",
    });
    await expect(verifier(request, new Uint8Array())).resolves.toBe(false);
  });

  it("rejects a webhook with a malformed bearer token", async () => {
    const request = new Request("https://assistant.example/eve/v1/linq", {
      body: "{}",
      headers: { authorization: "Bearer aaa.bbb.ccc" },
      method: "POST",
    });
    await expect(verifier(request, new Uint8Array())).resolves.toBe(false);
  });

  it("drops messages from handles that are not linked to a verified user", async () => {
    capture.findOne.mockResolvedValue(null);

    await expect(
      onMessage(threadContext(), linqMessage("+15550100011"))
    ).resolves.toBeNull();
    expect(capture.findOne).toHaveBeenCalledExactlyOnceWith({
      model: "user",
      where: [{ field: "phoneNumber", value: "+15550100011" }],
    });
  });

  it("drops messages from handles whose user has not verified the phone", async () => {
    capture.findOne.mockResolvedValue({
      id: "user-1",
      phoneNumberVerified: false,
    });

    await expect(
      onMessage(threadContext(), linqMessage("+15550100011"))
    ).resolves.toBeNull();
  });

  it("scopes a verified handle to that user's own workspace", async () => {
    capture.findOne.mockResolvedValue({
      id: "user-1",
      phoneNumberVerified: true,
    });

    const result = await onMessage(
      threadContext(),
      linqMessage("+15550100011")
    );

    expect(result?.auth?.principalId).toBe("better-auth:user-1");
    expect(result?.auth?.attributes).toMatchObject({
      conversationChannel: "linq",
      conversationId: "linq:dm:chat-1",
      linqMessageId: "message-1",
      phoneNumber: "+15550100011",
    });
    expect(result?.auth?.attributes.workspaceId).toMatch(
      /^personal:[0-9a-f]{32}$/
    );
  });
});

type InboundContext = Parameters<
  NonNullable<LinqChannelConfig["onMessage"]>
>[0];

interface ThreadIdentity {
  readonly thread: Pick<InboundContext["thread"], "id">;
}

function threadContext(): InboundContext {
  const identity: ThreadIdentity = { thread: { id: "linq:dm:chat-1" } };
  // SAFETY: The inbound policy reads only the thread id from this context.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete Chat SDK thread mock would add unrelated methods.
  return identity as InboundContext;
}

function linqMessage(handle: string) {
  return new Message({
    attachments: [],
    author: {
      fullName: handle,
      isBot: false,
      isMe: false,
      userId: handle,
      userName: handle,
    },
    formatted: { children: [], type: "root" },
    id: "message-1",
    metadata: {
      dateSent: new Date("2026-09-03T00:00:00.000Z"),
      edited: false,
    },
    raw: {},
    text: "list my vault items",
    threadId: "linq:dm:chat-1",
  });
}
