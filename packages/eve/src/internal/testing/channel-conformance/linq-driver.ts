import { createHmac } from "node:crypto";

import { linqChannel } from "#public/channels/linq/index.js";
import {
  type ChannelDriver,
  type PlatformCall,
  numberedOptions,
  recordingFetch,
} from "#internal/testing/channel-conformance/harness.js";

const API_KEY = "linq-conformance-api-key";
const SIGNING_KEY = Buffer.from("linq-conformance-signing-key");
const SIGNING_SECRET = `whsec_${SIGNING_KEY.toString("base64")}`;
const BASE_URL = "https://linq-conformance.invalid/api/partner";
const PERSON = "alice";
let nextChat = 0;

interface LinqPart {
  readonly type?: string;
  readonly value?: string;
}

interface LinqMessageBody {
  readonly message?: { readonly parts?: readonly LinqPart[] };
}

/** Drives the real Linq adapter through a signed direct-message webhook. */
export function linqDriver(): ChannelDriver {
  nextChat += 1;
  const chatId = `linq-conformance-chat-${nextChat}`;
  let messageId = 0;
  let restoreFetch: (() => void) | undefined;

  function signedMessage(text: string): Request {
    messageId += 1;
    const body = JSON.stringify({
      data: {
        chat: { id: chatId, is_group: false },
        direction: "inbound",
        id: `linq-inbound-${messageId}`,
        parts: [{ type: "text", value: text }],
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
    name: "linq",
    capabilities: ["text-replies"],
    createChannel(record) {
      const previousFetch = globalThis.fetch;
      const fakeFetch = recordingFetch(record, async (request) => {
        const url = new URL(request.url);
        const bodyText = await request.text();
        return {
          body: bodyText === "" ? {} : JSON.parse(bodyText),
          method: `${request.method} ${url.pathname}`,
          response: {},
        };
      });
      // The adapter accepts no fetch option, so route only its test host globally and preserve other fetches.
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.hostname === new URL(BASE_URL).hostname) return fakeFetch(input, init);
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

function postedText(call: PlatformCall): string | undefined {
  if (!call.method.endsWith("/messages")) return undefined;
  const parts = (call.body as LinqMessageBody).message?.parts;
  return parts
    ?.filter((part) => part.type === "text")
    .map((part) => part.value ?? "")
    .join("");
}
