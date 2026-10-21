import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";

import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";

import type { SessionAuthContext } from "#channel/types.js";
import { chatSdkChannel, messageToUserContent } from "#public/channels/chat-sdk/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import type { StateAdapter } from "#compiled/chat/index.js";
import {
  type ChannelDriver,
  type PlatformCall,
  type RenderedOption,
  type SentFile,
  recordingFetch,
  serveFile,
} from "#internal/testing/channel-conformance/harness.js";

const ACCESS_TOKEN = "whatsapp-conformance-token";
const APP_SECRET = "whatsapp-conformance-app-secret";
const PHONE_NUMBER_ID = "100000000000001";
// `.invalid` never resolves, so nothing that bypasses the fake reaches the network.
const GRAPH_HOST = "graph.whatsapp-conformance.invalid";
let nextPerson = 0;

interface WhatsAppButton {
  readonly reply: { readonly id: string; readonly title: string };
}

interface WhatsAppSend {
  readonly type?: string;
  readonly text?: { readonly body?: string };
  readonly interactive?: {
    readonly body?: { readonly text?: string };
    readonly action?: { readonly buttons?: readonly WhatsAppButton[] };
  };
}

/**
 * Drives the real `@chat-adapter/whatsapp` adapter through Meta-signed Cloud
 * API webhooks in a 1:1 chat, configured as the Chat SDK docs recommend for an
 * adapter that can't edit sent messages.
 * Every Graph API call the adapter makes reaches a fake that records it;
 * webhook verification, parsing, media download, and outbound rendering are
 * the adapter's own code.
 */
export function whatsappDriver(): ChannelDriver {
  nextPerson += 1;
  const waId = `1555010${String(nextPerson).padStart(4, "0")}`;
  let inbound = 0;
  let outbound = 0;
  let restoreFetch: (() => void) | undefined;
  /** Files a person sent, by the media id the webhook lists each under. */
  const uploads = new Map<string, SentFile>();

  function webhook(message: Record<string, unknown>): Request {
    inbound += 1;
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                contacts: [{ profile: { name: "Alice" }, wa_id: waId }],
                messages: [
                  {
                    from: waId,
                    id: `wamid.inbound-${inbound}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    ...message,
                  },
                ],
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550000000", phone_number_id: PHONE_NUMBER_ID },
              },
            },
          ],
          id: "whatsapp-business-account",
        },
      ],
      object: "whatsapp_business_account",
    });
    const signature = createHmac("sha256", APP_SECRET).update(body).digest("hex");
    return new Request("https://agent.example.com/eve/v1/whatsapp", {
      body,
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}` },
      method: "POST",
    });
  }

  function message(text: string, files: readonly SentFile[] = []): Request {
    const [file, ...rest] = files;
    if (rest.length > 0) throw new Error("A WhatsApp message carries at most one file.");
    if (file === undefined) return webhook({ text: { body: text }, type: "text" });
    // A file arrives as a media id, with the message text as its caption.
    const id = `media-${inbound + 1}`;
    uploads.set(id, file);
    const kind = file.mediaType.startsWith("image/") ? "image" : "document";
    return webhook({
      [kind]: { caption: text, filename: file.name, id, mime_type: file.mediaType },
      type: kind,
    });
  }

  async function decode(request: Request): Promise<PlatformCall> {
    const url = new URL(request.url);
    const mediaId = /^\/v[\d.]+\/(media-\d+)$/u.exec(url.pathname)?.[1];
    if (request.method === "GET" && mediaId !== undefined) {
      // Step one of a media download: the Graph API answers with the file's URL.
      return {
        body: {},
        method: `GET ${url.pathname}`,
        response: { id: mediaId, url: `https://${GRAPH_HOST}/files/${mediaId}` },
      };
    }
    if (request.method === "GET" && url.pathname.startsWith("/files/")) {
      // Meta serves media only to the access token's bearer.
      if (request.headers.get("authorization") !== `Bearer ${ACCESS_TOKEN}`) {
        return {
          body: {},
          method: `GET ${url.pathname}`,
          response: new Response("Unauthorized", { status: 401 }),
        };
      }
      const file = uploads.get(url.pathname.slice("/files/".length));
      return { body: {}, method: `GET ${url.pathname}`, response: serveFile(file) };
    }
    const bodyText = await request.text();
    const body = bodyText === "" ? {} : (JSON.parse(bodyText) as Record<string, unknown>);
    // Read receipts and typing indicators share the send endpoint but send nothing.
    if (body.status === "read") {
      return { body, method: "read", response: { success: true } };
    }
    outbound += 1;
    return {
      body,
      method: `${request.method} ${url.pathname}`,
      response: {
        contacts: [{ input: waId, wa_id: waId }],
        messages: [{ id: `wamid.outbound-${outbound}` }],
        messaging_product: "whatsapp",
      },
    };
  }

  return {
    name: "whatsapp",
    personId: waId,
    capabilities: ["attachments", "buttons", "text-replies"],
    surface: "private",
    createChannel(record) {
      const previousFetch = globalThis.fetch;
      const fakeFetch = recordingFetch(record, decode);
      // The adapter takes no fetch option, so route only the fake Graph host globally.
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        return url.hostname === GRAPH_HOST ? fakeFetch(input, init) : previousFetch(input, init);
      };
      const restoreHttps = routeHttps(fakeFetch);
      restoreFetch = () => {
        globalThis.fetch = previousFetch;
        restoreHttps();
        restoreFetch = undefined;
      };
      const bridge = chatSdkChannel({
        adapters: {
          whatsapp: createWhatsAppAdapter({
            accessToken: ACCESS_TOKEN,
            apiUrl: `https://${GRAPH_HOST}`,
            appSecret: APP_SECRET,
            phoneNumberId: PHONE_NUMBER_ID,
            verifyToken: "whatsapp-conformance-verify-token",
          }),
        },
        // WhatsApp can't edit, so replies post once (`streaming: false`), and every message
        // reaches eve (`concurrency`). `resolveInputAuth` and each `send`'s `auth` are the
        // documented identity wiring that the permission rules need.
        concurrency: "concurrent",
        resolveInputAuth: (event) => userAuth(event.user.userId),
        state: createMemoryState() as StateAdapter,
        streaming: false,
        userName: "eve",
      });
      bridge.bot.onNewMention(async (thread, incoming) => {
        await thread.subscribe();
        await bridge.send(messageToUserContent(incoming), {
          auth: userAuth(incoming.author.userId),
          thread,
        });
      });
      bridge.bot.onSubscribedMessage(async (thread, incoming) => {
        await bridge.send(messageToUserContent(incoming), {
          auth: userAuth(incoming.author.userId),
          thread,
        });
      });
      return bridge.channel;
    },
    dispose() {
      restoreFetch?.();
    },
    message: (text, _person, files) => message(text, files),
    findOptions(call, prompt) {
      const text = postedText(call);
      if (text === undefined || !text.includes(prompt)) return undefined;
      return buttonsOf(call);
    },
    press(option) {
      const { id, title } = option.handle as WhatsAppButton["reply"];
      return webhook({
        interactive: { button_reply: { id, title }, type: "button_reply" },
        type: "interactive",
      });
    },
    postedText,
    shownMessage(call) {
      const text = postedText(call);
      if (text === undefined) return undefined;
      const { messages } = call.response as { readonly messages: readonly { id: string }[] };
      return { id: messages[0]!.id, options: buttonsOf(call), text };
    },
  };
}

/**
 * Media downloads leave through `node:https` with their own DNS checks rather
 * than `fetch`, so route requests for the fake Graph host through `fetch` too.
 */
function routeHttps(fetch: typeof globalThis.fetch): () => void {
  const original = https.request;
  https.request = ((url: string | URL, options: unknown, callback?: (res: unknown) => void) => {
    const target = new URL(String(url));
    if (target.hostname !== GRAPH_HOST) return (original as Function)(url, options, callback);
    const request = Object.assign(new EventEmitter(), {
      destroy() {},
      end() {
        const headers = (options as { readonly headers?: Record<string, string> } | undefined)
          ?.headers;
        void fetch(target, { headers }).then(
          async (response) => {
            const bytes = Buffer.from(await response.arrayBuffer());
            callback?.(
              Object.assign(Readable.from([bytes]), {
                headers: {
                  "content-length": String(bytes.length),
                  "content-type":
                    response.headers.get("content-type") ?? "application/octet-stream",
                },
                statusCode: response.status,
                statusMessage: response.statusText,
              }),
            );
          },
          (error: unknown) => request.emit("error", error),
        );
      },
    });
    return request;
  }) as typeof https.request;
  // The adapter imports `request` by name; this updates that binding too.
  syncBuiltinESMExports();
  return () => {
    https.request = original;
    syncBuiltinESMExports();
  };
}

/** The auth an app derives from the sender, as the Chat SDK docs' `resolveInputAuth` example does. */
function userAuth(userId: string): SessionAuthContext {
  return { attributes: {}, authenticator: "whatsapp", principalId: userId, principalType: "user" };
}

function sendOf(call: PlatformCall): WhatsAppSend | undefined {
  return call.method.endsWith("/messages") ? (call.body as WhatsAppSend) : undefined;
}

/**
 * Text the bot sent: a text message's body, or the body above an interactive
 * message's buttons. The adapter renders markdown with backslash escapes
 * (`ask\_question`) that WhatsApp has no syntax for, so a person sees the
 * backslashes; this reads past them so rules can check the conversation itself.
 */
function postedText(call: PlatformCall): string | undefined {
  const sent = sendOf(call);
  return (sent?.text?.body ?? sent?.interactive?.body?.text)?.replace(
    /\\([\\`*_{}[\]()#+\-.!~|>])/gu,
    "$1",
  );
}

/** The reply buttons WhatsApp shows under an interactive message, by their (truncated) titles. */
function buttonsOf(call: PlatformCall): RenderedOption[] {
  return (sendOf(call)?.interactive?.action?.buttons ?? []).map(({ reply }) => ({
    handle: reply,
    label: reply.title,
  }));
}
