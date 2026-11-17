import type { Attachment, Message } from "#compiled/chat/index.js";

const IMESSAGE_PLATFORM = "iMessage";

interface SpectrumContent {
  readonly content?: SpectrumContent;
  readonly id?: unknown;
  readonly items?: readonly { readonly content?: SpectrumContent }[];
  readonly type?: unknown;
}

interface SpectrumAttachment {
  read(): Promise<Buffer>;
}

interface SpectrumApp {
  readonly __internal: {
    readonly platforms: ReadonlyMap<
      string,
      {
        readonly client: unknown;
        readonly config: unknown;
        readonly store: unknown;
        readonly definition: {
          readonly actions?: {
            readonly getAttachment?: (
              ctx: { readonly client: unknown; readonly config: unknown; readonly store: unknown },
              id: string,
              phone?: string,
            ) => Promise<SpectrumAttachment | undefined>;
          };
        };
      }
    >;
  };
}

interface PhotonAdapter {
  readonly app: unknown;
  fetchMessage(threadId: string, messageId: string): Promise<Message | null>;
  rehydrateAttachment?(attachment: Attachment): Attachment;
}

export async function addPhotonAttachmentDownloads(
  message: Message,
  adapter: PhotonAdapter,
): Promise<void> {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return;
  const raw = message.raw as { readonly content?: SpectrumContent; readonly space?: unknown };
  const ids = contentAttachmentIds(raw.content);
  if (attachments.some((_, index) => ids[index] === undefined)) {
    const refetched = await refetchedAttachmentIds(adapter, message);
    attachments.forEach((_, index) => {
      ids[index] ??= refetched[index];
    });
  }
  const phone = spacePhone(raw.space);
  attachments.forEach((attachment: Attachment, index) => {
    const id = ids[index];
    if (attachment.fetchData !== undefined || id === undefined) return;
    attachment.fetchMetadata = phone === undefined ? { id } : { id, phone };
    attachment.fetchData = () => downloadAttachment(adapter.app, id, phone);
  });
}

export function addPhotonAttachmentRehydration(adapter: PhotonAdapter): void {
  adapter.rehydrateAttachment = (attachment) => {
    const { id, phone } = attachment.fetchMetadata ?? {};
    if (id === undefined) return attachment;
    return { ...attachment, fetchData: () => downloadAttachment(adapter.app, id, phone) };
  };
}

async function refetchedAttachmentIds(
  adapter: PhotonAdapter,
  message: Message,
): Promise<(string | undefined)[]> {
  try {
    const refetched = await adapter.fetchMessage(message.threadId, message.id);
    const raw = refetched?.raw as { readonly content?: SpectrumContent } | undefined;
    return contentAttachmentIds(raw?.content);
  } catch {
    return [];
  }
}

async function downloadAttachment(app: unknown, id: string, phone?: string): Promise<Buffer> {
  const runtime = (app as SpectrumApp | null)?.__internal?.platforms.get(IMESSAGE_PLATFORM);
  const getAttachment = runtime?.definition.actions?.getAttachment;
  if (runtime === undefined || getAttachment === undefined) {
    throw new Error("The iMessage adapter has no Spectrum app to download attachments with.");
  }
  const found = await getAttachment(
    { client: runtime.client, config: runtime.config, store: runtime.store },
    id,
    phone,
  );
  if (found === undefined) throw new Error(`iMessage attachment ${id} was not found.`);
  return await found.read();
}

function contentAttachmentIds(content: SpectrumContent | undefined): (string | undefined)[] {
  if (content === undefined) return [];
  if (content.type === "attachment" || content.type === "voice") {
    return [typeof content.id === "string" && content.id.length > 0 ? content.id : undefined];
  }
  if (content.type === "reply") return contentAttachmentIds(content.content);
  if (content.type === "group") {
    return (content.items ?? []).flatMap((item) => contentAttachmentIds(item.content));
  }
  return [];
}

function spacePhone(space: unknown): string | undefined {
  if (typeof space !== "object" || space === null) return undefined;
  const phone = (space as { readonly phone?: unknown }).phone;
  return typeof phone === "string" ? phone : undefined;
}
