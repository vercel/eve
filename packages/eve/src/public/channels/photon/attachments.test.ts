import { describe, expect, it, vi } from "vitest";

import { type Attachment, Message } from "#compiled/chat/index.js";
import {
  addPhotonAttachmentDownloads,
  addPhotonAttachmentRehydration,
} from "#public/channels/photon/attachments.js";

function message(raw: unknown, names: readonly string[]): Message {
  return new Message({
    attachments: names.map((name) => ({ mimeType: "image/jpeg", name, type: "image" as const })),
    formatted: { type: "root", children: [] },
    metadata: { dateSent: new Date(0), edited: false },
    author: { fullName: "User", isBot: false, isMe: false, userId: "user", userName: "user" },
    id: "message-id",
    raw,
    text: "",
    threadId: "thread-id",
  });
}

/** A Photon app serving `files` by attachment id, whose `fetchMessage` returns `refetchedRaw`. */
function appServing(files: Record<string, string>, refetchedRaw?: unknown) {
  const getAttachment = vi.fn(async (_ctx: unknown, id: string, _phone?: string) =>
    files[id] === undefined ? undefined : { read: async () => Buffer.from(files[id]!) },
  );
  const runtime = {
    client: "client",
    config: "config",
    definition: { actions: { getAttachment } },
  };
  const app = {
    __internal: { platforms: new Map([["iMessage", { ...runtime, store: "store" }]]) },
  };
  const fetchMessage = vi.fn(async (_threadId: string, _messageId: string) =>
    refetchedRaw === undefined ? null : message(refetchedRaw, []),
  );
  const adapter: {
    app: unknown;
    fetchMessage: typeof fetchMessage;
    rehydrateAttachment?(attachment: Attachment): Attachment;
  } = { app, fetchMessage };
  return { adapter, fetchMessage, getAttachment };
}

describe("addPhotonAttachmentDownloads", () => {
  it("downloads each webhook attachment by its id, in the order the adapter lists them", async () => {
    const { adapter, getAttachment } = appServing({ "a-1": "first", "a-2": "second" });
    const inbound = message(
      {
        content: {
          items: [
            { content: { text: "Here you go", type: "text" } },
            { content: { id: "a-1", name: "one.jpg", type: "attachment" } },
            {
              content: {
                content: { id: "a-2", name: "two.jpg", type: "attachment" },
                type: "reply",
              },
            },
          ],
          type: "group",
        },
        space: { id: "chat", phone: "+15550100" },
      },
      ["one.jpg", "two.jpg"],
    );

    await addPhotonAttachmentDownloads(inbound, adapter);

    const [one, two] = inbound.attachments;
    expect(await one?.fetchData?.()).toEqual(Buffer.from("first"));
    expect(await two?.fetchData?.()).toEqual(Buffer.from("second"));
    expect(getAttachment).toHaveBeenCalledWith(
      { client: "client", config: "config", store: "store" },
      "a-1",
      "+15550100",
    );
  });

  it("refetches the message by id when the webhook omits a voice note's id", async () => {
    const { adapter, fetchMessage, getAttachment } = appServing(
      { "v-1": "audio" },
      { content: { id: "v-1", type: "attachment" } },
    );
    const inbound = message(
      { content: { type: "voice" }, space: { id: "chat", phone: "+15550100" } },
      ["voice"],
    );

    await addPhotonAttachmentDownloads(inbound, adapter);

    expect(fetchMessage).toHaveBeenCalledWith("thread-id", "message-id");
    expect(inbound.attachments[0]?.fetchMetadata).toEqual({ id: "v-1", phone: "+15550100" });
    expect(await inbound.attachments[0]?.fetchData?.()).toEqual(Buffer.from("audio"));
    expect(getAttachment).toHaveBeenCalledWith(expect.anything(), "v-1", "+15550100");
  });

  it("keeps the webhook's ids and fills only the missing ones from the refetch", async () => {
    // The refetched copy is shaped differently: its photo has no id.
    const { adapter } = appServing(
      { "p-1": "photo", "v-1": "audio" },
      {
        content: {
          items: [
            { content: { type: "attachment" } },
            { content: { id: "v-1", type: "attachment" } },
          ],
          type: "group",
        },
      },
    );
    const inbound = message(
      {
        content: {
          items: [
            { content: { id: "p-1", name: "photo.jpg", type: "attachment" } },
            { content: { type: "voice" } },
          ],
          type: "group",
        },
      },
      ["photo.jpg", "voice"],
    );

    await addPhotonAttachmentDownloads(inbound, adapter);

    const [photo, voice] = inbound.attachments;
    expect(await photo?.fetchData?.()).toEqual(Buffer.from("photo"));
    expect(await voice?.fetchData?.()).toEqual(Buffer.from("audio"));
  });

  it("leaves an attachment without a download when the refetch fails", async () => {
    const { adapter, fetchMessage } = appServing({});
    fetchMessage.mockRejectedValueOnce(new Error("Photon is unavailable"));
    const inbound = message({ content: { type: "voice" } }, ["voice"]);

    await addPhotonAttachmentDownloads(inbound, adapter);

    expect(inbound.attachments[0]?.fetchData).toBeUndefined();
  });

  it("fails the download when iMessage no longer has the attachment", async () => {
    const { adapter } = appServing({});
    const inbound = message({ content: { id: "gone", type: "attachment" } }, ["gone.jpg"]);

    await addPhotonAttachmentDownloads(inbound, adapter);

    await expect(inbound.attachments[0]?.fetchData?.()).rejects.toThrow(
      "iMessage attachment gone was not found.",
    );
  });

  it("rebuilds the download from fetchMetadata alone, as after the queue", async () => {
    const { adapter, getAttachment } = appServing({ "a-1": "first" });
    const inbound = message(
      { content: { id: "a-1", type: "attachment" }, space: { id: "chat", phone: "+15550100" } },
      ["one.jpg"],
    );
    await addPhotonAttachmentDownloads(inbound, adapter);
    addPhotonAttachmentRehydration(adapter);

    const { fetchData: _dropped, ...serialized } = inbound.attachments[0]!;
    const rehydrated = adapter.rehydrateAttachment!(serialized);

    expect(serialized.fetchMetadata).toEqual({ id: "a-1", phone: "+15550100" });
    expect(await rehydrated.fetchData?.()).toEqual(Buffer.from("first"));
    expect(getAttachment).toHaveBeenCalledWith(expect.anything(), "a-1", "+15550100");
  });
});
