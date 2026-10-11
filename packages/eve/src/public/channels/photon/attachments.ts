import type { Attachment, Message } from "#compiled/chat/index.js";

const IMESSAGE_PLATFORM = "iMessage";

/** The part of a Spectrum message eve reads to find each attachment's id. */
interface SpectrumContent {
  readonly content?: SpectrumContent;
  readonly id?: unknown;
  readonly items?: readonly { readonly content?: SpectrumContent }[];
  readonly type?: unknown;
}

/** An attachment iMessage's `getAttachment` resolves, as spectrum-ts wraps it. */
interface SpectrumAttachment {
  read(): Promise<Buffer>;
}

/**
 * The slice of a spectrum-ts app that holds each platform's runtime. It is
 * what `imessage(app)` reads to bind iMessage's instance actions, such as
 * `getAttachment`.
 */
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

/** The adapter that owns the spectrum-ts app eve downloads attachments through. */
interface PhotonAdapter {
  readonly app: unknown;
  rehydrateAttachment?(attachment: Attachment): Attachment;
}

/**
 * Lets eve download each file a person sent over iMessage. The Spectrum
 * webhook lists an attachment's name and type but never its bytes, so this
 * records each attachment's id in its `fetchMetadata` and gives it a
 * `fetchData`; the channel downloads it later, in the step, through
 * {@link addPhotonAttachmentRehydration}.
 */
export function addPhotonAttachmentDownloads(message: Message, adapter: PhotonAdapter): void {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return;
  const raw = message.raw as { readonly content?: SpectrumContent; readonly space?: unknown };
  // The adapter lists attachments in the order it walks the content, so their ids line up.
  const ids = contentAttachmentIds(raw.content);
  const phone = spacePhone(raw.space);
  attachments.forEach((attachment: Attachment, index) => {
    const id = ids[index];
    if (attachment.fetchData !== undefined || id === undefined) return;
    attachment.fetchMetadata = phone === undefined ? { id } : { id, phone };
    attachment.fetchData = () => downloadAttachment(adapter.app, id, phone);
  });
}

/**
 * Gives the adapter a `rehydrateAttachment`, which the iMessage adapter lacks,
 * so the channel can rebuild an attachment's download from its `fetchMetadata`
 * after the message crosses the queue.
 */
export function addPhotonAttachmentRehydration(adapter: PhotonAdapter): void {
  adapter.rehydrateAttachment = (attachment) => {
    const { id, phone } = attachment.fetchMetadata ?? {};
    if (id === undefined) return attachment;
    return { ...attachment, fetchData: () => downloadAttachment(adapter.app, id, phone) };
  };
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

/** Walks content the way the adapter does, so the result lines up with `message.attachments`. */
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
