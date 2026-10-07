import { createHmac } from "node:crypto";

import { photonIMessageChannel } from "#public/channels/photon/index.js";
import { iMessageAdapter } from "#compiled/@photon-ai/chat-adapter-imessage/index.js";
import {
  type ChannelDriver,
  type PlatformCall,
  type SentFile,
  numberedOptions,
} from "#internal/testing/channel-conformance/harness.js";

const WEBHOOK_SECRET = "photon-conformance-webhook-secret";
const PERSON = "+15550100";
let nextChat = 0;

interface SpectrumContent {
  readonly type: string;
  readonly markdown?: string;
  readonly text?: string;
}

interface ContentBuilder {
  build(): Promise<SpectrumContent>;
}

/**
 * Drives the real Photon iMessage adapter through a signed Spectrum webhook in
 * a direct chat. spectrum-ts sends over gRPC rather than `fetch`, so the driver
 * replaces the adapter's Space lookup with a fake Space that records each
 * send; everything above it (webhook verification, parsing, outbound
 * rendering, read receipts) is Photon's own code.
 */
export function photonDriver(): ChannelDriver {
  nextChat += 1;
  const chatGuid = `iMessage;-;${PERSON}${nextChat}`;
  let sequence = 0;
  let restore: (() => void) | undefined;
  /** Files a person sent, by the attachment id the webhook lists each under. */
  const uploads = new Map<string, SentFile>();

  function webhook(text: string, files: readonly SentFile[] = []): Request {
    sequence += 1;
    const content =
      files.length === 0
        ? { text, type: "text" }
        : {
            // A message with files arrives as a group: its text, then one attachment per file.
            items: [
              { content: { text, type: "text" } },
              ...files.map((file, index) => {
                const id = `photon-attachment-${sequence}-${index}`;
                uploads.set(id, file);
                return {
                  content: {
                    id,
                    mimeType: file.mediaType,
                    name: file.name,
                    size: file.bytes.length,
                    type: "attachment",
                  },
                };
              }),
            ],
            type: "group",
          };
    const body = JSON.stringify({
      event: "messages",
      message: {
        content,
        direction: "inbound",
        id: `photon-inbound-${sequence}`,
        sender: { id: PERSON },
        timestamp: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      },
      space: { id: chatGuid },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", WEBHOOK_SECRET)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");
    return new Request("https://agent.example.com/eve/v1/photon", {
      body,
      headers: {
        "content-type": "application/json",
        "x-spectrum-event": "messages",
        "x-spectrum-signature": `v0=${signature}`,
        "x-spectrum-timestamp": timestamp,
      },
      method: "POST",
    });
  }

  async function getUpload(_ctx: unknown, id: string) {
    const file = uploads.get(id);
    if (file === undefined) return undefined;
    return {
      async read() {
        if (file.downloadable === false)
          throw new Error(`Attachment ${id} could not be downloaded`);
        return Buffer.from(file.bytes);
      },
    };
  }

  return {
    name: "photon",
    personId: PERSON,
    capabilities: ["attachments", "text-replies"],
    surface: "private",
    createChannel(record) {
      async function recordSend(method: string, builder: ContentBuilder) {
        sequence += 1;
        const id = `photon-posted-${sequence}`;
        record({ body: await builder.build(), method, response: { id } });
        return message(id);
      }
      function message(id: string) {
        return {
          id,
          edit: (builder: ContentBuilder) => recordSend("edit", builder),
          read: async () => {},
        };
      }
      const space = {
        id: chatGuid,
        getMessage: async (id: string) => message(id),
        send: (builder: ContentBuilder) => recordSend("send", builder),
        startTyping: async () => {},
        stopTyping: async () => {},
      };
      // The webhook never carries a file's bytes; eve fetches each by id through
      // iMessage's `getAttachment`, which this app's iMessage runtime serves.
      const app = {
        __internal: {
          platforms: new Map([
            [
              "iMessage",
              {
                client: null,
                config: null,
                store: null,
                definition: { actions: { getAttachment: getUpload } },
              },
            ],
          ]),
        },
      };
      // The channel builds its adapter internally, so patch the prototype's
      // private seams to spectrum-ts: building the app and looking up a Space.
      const fakes = {
        async ensureApp(this: { app: unknown }) {
          this.app = app;
        },
        resolveSpace: async () => space,
      };
      const originals = Object.keys(fakes).map(
        (key) => [key, Reflect.get(iMessageAdapter.prototype, key)] as const,
      );
      for (const [key, fake] of Object.entries(fakes)) {
        Reflect.set(iMessageAdapter.prototype, key, fake);
      }
      restore = () => {
        for (const [key, original] of originals) {
          Reflect.set(iMessageAdapter.prototype, key, original);
        }
        restore = undefined;
      };
      return photonIMessageChannel({
        credentials: () => ({ projectId: "photon-project", projectSecret: "photon-secret" }),
        webhookSecret: WEBHOOK_SECRET,
      });
    },
    dispose() {
      restore?.();
    },
    message: (text, _person, files) => webhook(text, files),
    findOptions(call, prompt) {
      const text = postedText(call);
      if (text === undefined || !text.includes(prompt)) return undefined;
      return numberedOptions(text);
    },
    press() {
      throw new Error("iMessage has no pressable HITL controls.");
    },
    postedText,
  };
}

function postedText(call: PlatformCall): string | undefined {
  if (call.method !== "send" && call.method !== "edit") return undefined;
  const content = call.body as SpectrumContent;
  return content.text ?? content.markdown;
}
