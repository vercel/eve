import { recallChannel } from "#public/channels/recall/index.js";
import { signRecallWebhook } from "#public/channels/recall/verify.js";
import {
  type ChannelDriver,
  type PlatformCall,
  type Person,
  numberedOptions,
  recordingFetch,
  type ShownMessage,
} from "#internal/testing/channel-conformance/harness.js";

const API_KEY = "recall-conformance-api-key";
const SECRET = `whsec_${Buffer.from("recall-conformance-secret").toString("base64")}`;
const API_BASE_URL = "https://recall-conformance.invalid";
const PEOPLE = {
  alice: { id: 100, name: "Alice" },
  bob: { id: 200, name: "Bob" },
} as const satisfies Record<Person, { id: number; name: string }>;
let nextBot = 0;

interface ChatBody {
  readonly message?: string;
  readonly to?: string;
}

/**
 * Drives a Recall bot in a meeting through signed real-time webhooks. People
 * type in the meeting chat, or with `"speech"` say each message to the bot
 * by name. `platform` decides what the chat can do: only Zoom reaches one
 * participant privately. Messages `overheard` picks are spoken without naming
 * the bot, as people talking to each other do. Messages `privately` picks are
 * typed to the bot alone. `spoken` phrases a spoken message, by default
 * `Eve, <text>`.
 */
export function recallDriver(
  options: {
    readonly input?: "chat" | "speech";
    readonly platform?: string;
    readonly overheard?: (text: string, person: Person) => boolean;
    readonly privately?: (text: string, person: Person) => boolean;
    readonly spoken?: (text: string) => string;
  } = {},
): ChannelDriver {
  const input = options.input ?? "chat";
  const platform = options.platform ?? "zoom";
  nextBot += 1;
  const botId = `recall-conformance-bot-${nextBot}`;
  let delivery = 0;

  function webhook(event: string, data: Record<string, unknown>): Request {
    delivery += 1;
    const payload = JSON.stringify({
      data: { bot: { id: botId, metadata: {} }, data },
      event,
    });
    const id = `msg_recall_${nextBot}_${delivery}`;
    const timestamp = Math.floor(Date.now() / 1000);
    return new Request("https://agent.example.com/eve/v1/recall", {
      body: payload,
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-signature": `v1,${signRecallWebhook({ id, payload, secret: SECRET, timestamp })}`,
        "webhook-timestamp": String(timestamp),
      },
      method: "POST",
    });
  }

  function participant(person: Person) {
    return {
      ...PEOPLE[person],
      email: null,
      extra_data: {},
      is_host: person === "alice",
      platform,
    };
  }

  function message(text: string, person: Person): Request {
    const overheard = options.overheard?.(text, person) === true;
    if (input === "speech" || overheard) {
      return webhook("transcript.data", {
        participant: participant(person),
        words: (overheard ? text : (options.spoken?.(text) ?? `Eve, ${text}`))
          .split(/\s+/u)
          .map((word) => ({ end_timestamp: null, start_timestamp: { relative: 0 }, text: word })),
      });
    }
    return webhook("participant_events.chat_message", {
      data: { text, to: options.privately?.(text, person) === true ? "only_bot" : "everyone" },
      participant: participant(person),
      timestamp: { absolute: new Date().toISOString(), relative: 0 },
    });
  }

  async function decode(request: Request): Promise<PlatformCall> {
    const url = new URL(request.url);
    const text = await request.text();
    const body = text ? (JSON.parse(text) as ChatBody) : {};
    const chat = url.pathname === `/api/v1/bot/${botId}/send_chat_message/`;
    const authorized = request.headers.get("authorization") === `Token ${API_KEY}`;
    return {
      body,
      method: chat && authorized ? "send_chat_message" : `${request.method} ${url.pathname}`,
      response: authorized ? {} : new Response("Unauthorized", { status: 401 }),
    };
  }

  function chatOf(call: PlatformCall): ChatBody | undefined {
    if (call.method !== "send_chat_message") return undefined;
    return call.body as ChatBody;
  }

  const label = input === "speech" ? "recall-speech" : "recall";
  return {
    name: platform === "zoom" ? label : `${label}-${platform.replaceAll("_", "-")}`,
    personId: String(PEOPLE.alice.id),
    personShownAs: [PEOPLE.alice.name],
    capabilities: ["another-person", "text-replies"],
    surface: "shared",
    createChannel: (record) =>
      recallChannel({
        api: { apiBaseUrl: API_BASE_URL, fetch: recordingFetch(record, decode) },
        credentials: { apiKey: API_KEY, verificationSecret: SECRET },
      }),
    message: (text, person) => message(text, person),
    findOptions(call, prompt) {
      const text = chatOf(call)?.message;
      if (text === undefined || !text.includes(prompt)) return undefined;
      return numberedOptions(text);
    },
    press: () => {
      throw new Error("Meeting chat has no buttons to press.");
    },
    postedText: (call) => chatOf(call)?.message,
    shownMessage(call): ShownMessage | undefined {
      const chat = chatOf(call);
      if (chat?.message === undefined) return undefined;
      return {
        // Meeting chat can't edit a message, so each one is its own.
        id: chat.message,
        onlyPerson: chat.to !== undefined && chat.to !== "everyone",
        options: [],
        text: chat.message,
      };
    },
  };
}
