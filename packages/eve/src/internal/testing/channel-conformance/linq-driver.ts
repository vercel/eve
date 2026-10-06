import { createHmac } from "node:crypto";

import { linqChannel } from "#public/channels/linq/index.js";
import {
  type ChannelDriver,
  type PlatformCall,
  type Surface,
  numberedOptions,
  recordingFetch,
  type SentFile,
  serveFile,
} from "#internal/testing/channel-conformance/harness.js";

const API_KEY = "linq-conformance-api-key";
const SIGNING_KEY = Buffer.from("linq-conformance-signing-key");
const SIGNING_SECRET = `whsec_${SIGNING_KEY.toString("base64")}`;
const BASE_URL = "https://linq-conformance.invalid/api/partner";
// Stands in for cdn.linqapp.com; `.invalid` never resolves, so nothing that bypasses the fake reaches the network.
const CDN_HOST = "cdn.linq-conformance.invalid";
const PERSON = "alice";
let nextChat = 0;

interface LinqPart {
  readonly type?: string;
  readonly value?: string;
}

interface LinqMessageBody {
  readonly message?: { readonly parts?: readonly LinqPart[] };
  /** An edit's replacement text. */
  readonly text?: string;
}

/** Drives the real Linq adapter through signed webhooks, in a group chat by default or 1:1. */
export function linqDriver(surface: Exclude<Surface, "public"> = "shared"): ChannelDriver {
  const group = surface === "shared";
  nextChat += 1;
  const chatId = `linq-conformance-chat-${nextChat}`;
  let messageId = 0;
  let outbound = 0;
  let restoreFetch: (() => void) | undefined;
  /** Files a person sent, by the permanent CDN URL Linq lists each under. */
  const uploads = new Map<string, SentFile>();

  function signedMessage(text: string, files: readonly SentFile[] = []): Request {
    messageId += 1;
    // Linq sends each file as a `media` part beside the text.
    const media = files.map((file, index) => {
      const url = `https://${CDN_HOST}/${chatId}/${messageId}-${index}/${file.name}`;
      uploads.set(url, file);
      return {
        filename: file.name,
        id: `media-${messageId}-${index}`,
        mime_type: file.mediaType,
        size_bytes: file.bytes.length,
        type: "media",
        url,
      };
    });
    const body = JSON.stringify({
      data: {
        // Linq's bridge hears every group message; a mention would route past its handler.
        chat: { id: chatId, is_group: group },
        direction: "inbound",
        id: `linq-inbound-${messageId}`,
        parts: [{ type: "text", value: text }, ...media],
        sender_handle: { handle: PERSON, id: PERSON, is_me: false },
      },
      event_type: "message.received",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const id = `linq-webhook-${messageId}`;
    const signature = createHmac("sha256", SIGNING_KEY)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    return new Request("https://agent.example.com/eve/v1/linq", {
      body,
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-signature": `v1,${signature}`,
        "webhook-timestamp": String(timestamp),
      },
      method: "POST",
    });
  }

  return {
    name: group ? "linq" : "linq-dm",
    capabilities: ["attachments", "text-replies"],
    surface,
    createChannel(record) {
      const previousFetch = globalThis.fetch;
      const fakeFetch = recordingFetch(record, async (request) => {
        const url = new URL(request.url);
        if (url.hostname === CDN_HOST) {
          return {
            body: {},
            method: `GET ${url.pathname}`,
            response: serveFile(uploads.get(url.href)),
          };
        }
        const bodyText = await request.text();
        outbound += 1;
        const id = `linq-outbound-${outbound}`;
        return {
          body: bodyText === "" ? {} : JSON.parse(bodyText),
          method: `${request.method} ${url.pathname}`,
          // The adapter reads the sent or edited message's id back to edit it later.
          response: { chat_id: chatId, id, message: { id } },
        };
      });
      // The adapter accepts no fetch option, so route only its test host globally and preserve other fetches.
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.hostname === new URL(BASE_URL).hostname || url.hostname === CDN_HOST) {
          return fakeFetch(input, init);
        }
        return previousFetch(input, init);
      };
      restoreFetch = () => {
        globalThis.fetch = previousFetch;
        restoreFetch = undefined;
      };
      return linqChannel({
        baseURL: BASE_URL,
        credentials: { apiKey: API_KEY, signingSecret: SIGNING_SECRET },
      });
    },
    dispose() {
      restoreFetch?.();
    },
    message: signedMessage,
    findOptions(call, prompt) {
      if (!call.method.endsWith("/messages") || !postedText(call)?.includes(prompt))
        return undefined;
      // The Chat SDK bridge's fallback text replaces Linq's own `Options:` card flattening.
      return numberedOptions(postedText(call)!);
    },
    press() {
      throw new Error("Linq has no pressable HITL controls.");
    },
    postedText,
  };
}

/** Text the bot sent (`POST …/messages`) or edited a message to (`PATCH /messages/:id`). */
function postedText(call: PlatformCall): string | undefined {
  const body = call.body as LinqMessageBody;
  if (call.method.startsWith("PATCH ") && call.method.includes("/messages/")) return body.text;
  if (!call.method.endsWith("/messages")) return undefined;
  const parts = body.message?.parts;
  return parts
    ?.filter((part) => part.type === "text")
    .map((part) => part.value ?? "")
    .join("");
}
