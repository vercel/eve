import type * as EveTools from "eve/tools";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  dynamicTool,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { toolContextFor } from "@tests/helpers/tool-context";
import type * as EnvModule from "@shared/environment";
import type { readLinqOnboardingPhoneNumber } from "@db/services/auth/linq";
import messaging from "@agent/tools/messaging";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";

const controls = vi.hoisted(() => ({
  // SAFETY: Tests replace only this optional configured E.164 phone number.
  phone: "+12025550123" as string | undefined,
  readPhone: vi.fn<typeof readLinqOnboardingPhoneNumber>(),
  fetch: vi.fn<typeof fetch>(),
  apiKey: vi.fn<() => Promise<string>>(),
  readContactSent: vi.fn<() => boolean | undefined>(),
  // SAFETY: The mock adds only zero-argument state reset callbacks.
  reset: [] as (() => void)[],
}));

vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);
vi.mock("eve/context", () => ({
  defineState<T>(name: string, initial: () => T) {
    let value = initial();
    if (name === "openinstinct.contact-delivery")
      controls.readContactSent.mockImplementation(
        () => z.object({ sent: z.boolean() }).nullable().parse(value)?.sent
      );
    controls.reset.push(() => {
      value = initial();
    });
    return {
      get: () => value,
      update(update: (current: T) => T) {
        value = update(value);
      },
    };
  },
}));
vi.mock("@vercel/connect/eve", () => ({
  connectLinqCredentials: () => ({ apiKey: controls.apiKey }),
}));
vi.mock("@db/services/auth/linq", () => ({
  readLinqOnboardingPhoneNumber: controls.readPhone,
}));
vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: {
      ...original.env,
      LINQ_CONNECTOR: "linq/openinstinct",
      get LINQ_PHONE_NUMBER() {
        return controls.phone;
      },
    },
  };
});

beforeEach(() => {
  for (const reset of controls.reset) reset();
  vi.clearAllMocks();
  controls.phone = "+12025550123";
  controls.readPhone.mockResolvedValue("+12025550456");
  controls.apiKey.mockResolvedValue("linq-test-key");
  controls.fetch.mockReset().mockImplementation(async () =>
    Response.json({
      chat_id: "chat-1",
      message: { id: "contact-message-1" },
    })
  );
  vi.stubGlobal("fetch", controls.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("share_contact", () => {
  it("renders the contact in browser chat and suppresses repeats without sending to Linq", async () => {
    const tool = await shareContactTool();
    const first = await tool.execute(
      { text: "Save my contact." },
      toolContext()
    );
    expect(first).toMatchObject({
      kind: "message",
      text: "Save my contact.",
      attachments: [
        {
          kind: "file",
          mimeType: "text/vcard",
          name: "OpenInstinct.vcf",
        },
      ],
    });
    const contact = sendMessageOutputSchema.parse(first);
    expect(
      contact.kind === "message" && contact.attachments?.[0]?.url
    ).toContain(
      "https://example.com/contacts/openinstinct.vcf?phone=%2B12025550123&expires="
    );
    expect(controls.readPhone).not.toHaveBeenCalled();
    expect(controls.readContactSent()).toBe(true);
    expect(await tool.execute({ text: "Again." }, toolContext())).toBeNull();
    expect(controls.fetch).not.toHaveBeenCalled();
    expect(controls.apiKey).not.toHaveBeenCalled();
  });

  it("throws provider errors from execute and retries the original payload and key", async () => {
    controls.fetch.mockResolvedValueOnce(
      new Response("Rejected contact", { status: 400 })
    );
    const tool = await shareContactTool();
    const context = toolContext("linq");
    await expect(
      tool.execute({ text: "Save my contact." }, context)
    ).rejects.toThrow("400");
    expect(controls.readContactSent()).toBe(false);
    const firstRequest = sentRequest(0);
    const firstPayload: unknown = await firstRequest.json();
    expect(firstRequest.url).toContain("/chats/chat-1/messages");
    expect(firstRequest.headers.get("authorization")).toBe(
      "Bearer linq-test-key"
    );

    const output = await tool.execute(
      { text: "Rephrased introduction." },
      context
    );
    const contact = sendMessageOutputSchema.parse(output);
    if (contact.kind !== "message")
      throw new Error("Expected contact message.");
    expect(firstPayload).toEqual({
      message: {
        idempotency_key: "openinstinct-contact:session-1",
        parts: [
          { type: "text", value: "Save my contact." },
          { type: "media", url: contact.attachments?.[0]?.url },
        ],
      },
    });
    await expect(sentRequest(1).json()).resolves.toEqual(firstPayload);
    expect(controls.readContactSent()).toBe(true);
    expect(await tool.execute({ text: "Again." }, context)).toBeNull();
    expect(controls.fetch).toHaveBeenCalledTimes(2);
  });

  it("waits for provider acceptance before marking the contact sent", async () => {
    let accept: ((response: Response) => void) | undefined;
    controls.fetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        accept = resolve;
      })
    );
    const tool = await shareContactTool();
    const pending = tool.execute({ text: "Save me." }, toolContext("linq"));
    await vi.waitFor(() => {
      expect(controls.fetch).toHaveBeenCalledOnce();
    });
    expect(controls.readContactSent()).toBe(false);
    if (!accept) throw new Error("Expected pending provider request.");
    accept(
      Response.json({ chat_id: "chat-1", message: { id: "accepted-contact" } })
    );
    await pending;
    expect(controls.readContactSent()).toBe(true);
  });

  it.each(["linq:chat-1", "linq:chat-1:dm", "linq:chat-1:group"])(
    "uses the existing chat encoded by %s",
    async (threadId) => {
      const tool = await shareContactTool();
      await tool.execute({ text: "Save me." }, toolContext("linq", threadId));
      expect(sentRequest(0).url).toContain("/chats/chat-1/messages");
    }
  );

  it.each([
    "linq:pending:+12025550123",
    "linq:chat-1:other",
    "linq:dm:chat-1",
    "another:chat-1",
  ])(
    "rejects invalid or pending thread %s before sending",
    async (threadId) => {
      const tool = await shareContactTool();
      await expect(
        tool.execute({ text: "Save me." }, toolContext("linq", threadId))
      ).rejects.toThrow("current authenticated Linq conversation");
      expect(controls.fetch).not.toHaveBeenCalled();
    }
  );

  it("rejects a thread that differs from the authenticated conversation", async () => {
    const tool = await shareContactTool();
    const context = toolContext("linq", "linq:chat-1", {
      conversationId: "linq:other-chat",
    });
    await expect(tool.execute({ text: "Save me." }, context)).rejects.toThrow(
      "current authenticated Linq conversation"
    );
    expect(controls.fetch).not.toHaveBeenCalled();
  });

  it("uses the connector's onboarding number when no number is configured", async () => {
    controls.phone = undefined;
    const tool = await shareContactTool();
    const output = await tool.execute({ text: "Save me." }, toolContext());
    const contact = sendMessageOutputSchema.parse(output);
    expect(controls.readPhone).toHaveBeenCalledExactlyOnceWith(
      "linq/openinstinct"
    );
    expect(
      contact.kind === "message" && contact.attachments?.[0]?.url
    ).toContain("phone=%2B12025550456");
  });

  it("fails without preparing a delivery when the number is unavailable", async () => {
    controls.phone = undefined;
    controls.readPhone.mockResolvedValue(undefined);
    const tool = await shareContactTool();
    await expect(
      tool.execute({ text: "Save me." }, toolContext())
    ).rejects.toThrow("number is unavailable");
    expect(controls.readContactSent()).toBeUndefined();
  });

  it("requires an authenticated workspace user and is root-only", async () => {
    const tool = await shareContactTool();
    expect(tool.availableInSubagents).toBe(false);
    const context = toolContext();
    await expect(
      tool.execute(
        { text: "Save me." },
        {
          ...context,
          session: {
            ...context.session,
            auth: { current: null, initiator: null },
          },
        }
      )
    ).rejects.toThrow("authenticated user");
    expect(controls.readContactSent()).toBeUndefined();
  });
});

async function shareContactTool() {
  const tools = await evaluateDynamic(
    messaging,
    dynamicContextFor({
      auth: toolContext().session.auth,
      sessionId: "session-1",
    })
  );
  return dynamicTool(tools, "share_contact");
}

function toolContext(
  channel: "eve" | "linq" = "eve",
  threadId = "linq:chat-1",
  attributes: Record<string, string> = {}
): ToolContext {
  return toolContextFor({
    auth: {
      current: {
        attributes: {
          workspaceId: "workspace-1",
          conversationChannel: channel,
          conversationId: threadId,
          linqThreadId: threadId,
          ...attributes,
        },
        authenticator: "authjs",
        principalId: "user-1",
        principalType: "user",
      },
      initiator: null,
    },
    callId: "contact-call-1",
    sessionId: "session-1",
    toolName: "share_contact",
  });
}

function sentRequest(index: number) {
  const [input, init] = controls.fetch.mock.calls[index] ?? [];
  if (!input) throw new Error("Expected a provider request.");
  return new Request(input, init);
}
