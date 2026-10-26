import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { discordContinuationToken, discordChannel } from "#public/channels/discord/index.js";
import {
  type ChannelDriver,
  type Person,
  type PlatformCall,
  type RenderedOption,
  type Surface,
  recordingFetch,
  linkTargets,
  type SentFile,
  serveFile,
} from "#internal/testing/channel-conformance/harness.js";

let nextChannel = 0;
const PERSON = { id: "U_CONFORMANCE", username: "alice" } as const;
const PEOPLE = { alice: PERSON, bob: { id: "U_BOB", username: "bob" } } as const;
/** Discord's message flag (1 << 6) for a message only its recipient sees. */
const EPHEMERAL_FLAG = 64;

/** A message component eve renders for a choice: a button (type 2) or a select menu (type 3). */
interface DiscordComponent {
  readonly custom_id?: string;
  readonly label?: string;
  readonly options?: readonly { readonly label: string; readonly value: string }[];
  readonly type?: number;
}

interface PressHandle {
  readonly customId: string;
  readonly messageId: string;
  /** The pressed message's text, which Discord sends with every component press. */
  readonly content?: string;
  /** Set for a select menu option; a button press carries no value. */
  readonly value?: string;
}

function testKeys(): { privateKey: KeyObject; publicKeyHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey,
    publicKeyHex: Buffer.from(der).subarray(-32).toString("hex"),
  };
}

/**
 * How a person's messages reach eve: as `/ask` slash commands, or as ordinary
 * messages a Gateway relay forwards, optionally answered in a new thread.
 */
export type DiscordTransport = "interactions" | "gateway" | "gateway-threads";

/** The relay's identity; the conformance route trusts it the way production trusts the daemon. */
const RELAY_AUTH = {
  attributes: {},
  authenticator: "conformance-relay",
  principalId: "relay",
  principalType: "service",
} as const;

/**
 * Drives Discord, in a server text channel by default or in a DM. Messages
 * arrive as signed application-command interactions or, with a Gateway
 * transport, as forwarded `MESSAGE_CREATE` dispatches; presses are always
 * component interactions.
 */
export function discordDriver(
  surface: Exclude<Surface, "public"> = "shared",
  transport: DiscordTransport = "interactions",
): ChannelDriver {
  const dm = surface === "private";
  const gateway = transport !== "interactions";
  const threads = transport === "gateway-threads";
  // In a server, Discord names the actor as a member; in a DM, as a user.
  const where = (user: (typeof PEOPLE)[Person] = PERSON) =>
    dm
      ? { channel: { type: 1 }, user }
      : { channel: { type: 0 }, guild_id: "G_CONFORMANCE", member: { roles: [], user } };
  nextChannel += 1;
  const channelId = `C_CONFORMANCE_${nextChannel}`;
  const { privateKey, publicKeyHex } = testKeys();
  let interactionId = 0;
  let messageId = 0;
  /** Files a person attached, by the signed CDN URL Discord lists each under. */
  const uploads = new Map<string, SentFile>();
  /** The message each interaction token's `@original` response is, once known. */
  const originals = new Map<string, string>();
  /** Interaction tokens answered with an ephemeral deferred response, which only the presser sees. */
  const ephemeralTokens = new Set<string>();
  /** The thread the bot started for the conversation, once it has. */
  let threadId: string | undefined;
  /** The bot's latest channel message, which a person in a server replies to so the bot hears them. */
  let lastBotMessage: string | undefined;
  let dispatchSequence = 0;
  /** Where the conversation happens now: the channel, or the thread the bot moved it to. */
  const conversationChannel = () => threadId ?? channelId;

  function signed(body: string): Request {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString("hex");
    return new Request("https://agent.example.com/eve/v1/discord", {
      body,
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp,
      },
      method: "POST",
    });
  }

  async function decode(request: Request): Promise<PlatformCall> {
    const url = new URL(request.url);
    if (url.hostname === "cdn.discordapp.com") {
      return {
        body: {},
        method: `GET ${url.pathname}`,
        response: serveFile(uploads.get(url.href)),
      };
    }
    const text = await request.text();
    const body = text === "" ? {} : JSON.parse(text);
    const path = url.pathname;
    const method = `${request.method} ${path}`;
    if (path.endsWith("/typing")) {
      return { body, method, response: {} };
    }
    const channelLookup = /^\/api\/v\d+\/channels\/([^/]+)$/u.exec(path);
    if (request.method === "GET" && channelLookup !== null) {
      const id = channelLookup[1]!;
      return { body, method, response: { id, type: dm ? 1 : id === threadId ? 11 : 0 } };
    }
    if (path.endsWith("/threads")) {
      threadId = `T_CONFORMANCE_${channelId}`;
      return { body, method, response: { id: threadId, type: 11 } };
    }
    if (path.includes("/thread-members/")) return { body, method, response: {} };
    const id = writtenMessageId(request.method, path);
    if (request.method === "POST" && /\/channels\/[^/]+\/messages$/u.test(path)) {
      lastBotMessage = id;
    }
    return {
      body,
      method,
      response: { channel_id: /\/channels\/([^/]+)\//u.exec(path)?.[1] ?? channelId, id },
    };
  }

  /** `person`'s message as the relay forwards it: the Gateway dispatch, unchanged. */
  function gatewayMessage(text: string, person: Person, files: readonly SentFile[]): Request {
    dispatchSequence += 1;
    const id = `U_MESSAGE_${channelId}_${dispatchSequence}`;
    // In a server, a person mentions the bot once, then replies to its latest
    // message, unless the bot moved the conversation into a thread, where every
    // message reaches it. The mention sits on its own line so the test model's
    // line-based directives still read the message.
    const replyTo = !dm && !threads ? lastBotMessage : undefined;
    const mention = !dm && replyTo === undefined && threadId === undefined;
    return new Request("https://agent.example.com/eve/v1/discord/gateway", {
      body: JSON.stringify({
        d: {
          attachments: files.map((file, index) => {
            const attachmentId = `A_${id}_${index}`;
            const url = `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/${file.name}?ex=signed`;
            uploads.set(url, file);
            return {
              content_type: file.mediaType,
              filename: file.name,
              id: attachmentId,
              size: file.bytes.length,
              url,
            };
          }),
          author: PEOPLE[person],
          channel_id: conversationChannel(),
          content: mention ? `${text}\n<@APP1>` : text,
          ...(!dm && { guild_id: "G_CONFORMANCE" }),
          id,
          mentions: mention ? [{ id: "APP1" }] : [],
          ...(replyTo !== undefined && {
            message_reference: { message_id: replyTo, type: 0 },
            referenced_message: { author: { bot: true, id: "APP1" }, id: replyTo },
          }),
          type: replyTo === undefined ? 0 : 19,
        },
        op: 0,
        s: dispatchSequence,
        t: "MESSAGE_CREATE",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  /** Edits keep the id of the message they rewrite; everything else posts a new message. */
  function writtenMessageId(method: string, path: string): string {
    const original = /^\/api\/v\d+\/webhooks\/[^/]+\/([^/]+)\/messages\/@original$/u.exec(path);
    if (original !== null) {
      const token = original[1]!;
      const known = originals.get(token);
      if (known !== undefined) return known;
      const created = newMessageId();
      originals.set(token, created);
      return created;
    }
    const edited = /\/messages\/([^/@]+)$/u.exec(path);
    if (method === "PATCH" && edited !== null) return edited[1]!;
    return newMessageId();
  }

  function newMessageId(): string {
    messageId += 1;
    return `M_CONFORMANCE_${messageId}`;
  }

  function nextInteraction(): string {
    interactionId += 1;
    return `I_CONFORMANCE_${interactionId}`;
  }

  return {
    name: `discord${gateway ? `-${transport}` : ""}${dm ? "-dm" : ""}`,
    personId: PERSON.id,
    capabilities: [
      "attachments",
      ...(dm ? [] : (["another-person"] as const)),
      "buttons",
      ...(gateway ? (["text-replies"] as const) : []),
    ],
    surface,
    createChannel: (record) =>
      discordChannel({
        api: { fetch: recordingFetch(record, decode) },
        credentials: { applicationId: "APP1", botToken: "bot-token", publicKey: publicKeyHex },
        ...(gateway && { gateway: { auth: () => RELAY_AUTH, startThread: threads } }),
      }),
    // A reply to the bot's message continues the session that posted it.
    nextAddress: () =>
      gateway && !dm && !threads && lastBotMessage !== undefined
        ? discordContinuationToken(channelId, lastBotMessage)
        : undefined,
    message: (text, person, files = []) => {
      if (gateway) return gatewayMessage(text, person, files);
      const id = nextInteraction();
      // Each file rides an attachment option (type 11) whose value names it in `resolved`.
      const attached = files.map((file, index) => {
        const attachmentId = `A_${id}_${index}`;
        const url = `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/${file.name}?ex=signed`;
        uploads.set(url, file);
        return {
          attachmentId,
          option: {
            name: index === 0 ? "file" : `file${index + 1}`,
            type: 11,
            value: attachmentId,
          },
          resolved: {
            content_type: file.mediaType,
            filename: file.name,
            id: attachmentId,
            size: file.bytes.length,
            url,
          },
        };
      });
      return signed(
        JSON.stringify({
          ...where(PEOPLE[person]),
          application_id: "APP1",
          channel_id: channelId,
          data: {
            name: "ask",
            options: [
              { name: "message", type: 3, value: text },
              ...attached.map(({ option }) => option),
            ],
            ...(attached.length > 0 && {
              resolved: {
                attachments: Object.fromEntries(
                  attached.map(({ attachmentId, resolved }) => [attachmentId, resolved]),
                ),
              },
            }),
          },
          id,
          token: `tok-${id}`,
          type: 2,
          version: 1,
        }),
      );
    },
    findOptions(call, prompt) {
      if (!isMessageWrite(call)) return undefined;
      const body = call.body as {
        readonly components?: readonly { readonly components?: readonly DiscordComponent[] }[];
        readonly content?: string;
      };
      if (body.content?.includes(prompt) !== true) return undefined;
      return choicesOf(call);
    },
    shownMessage(call) {
      if (!isMessageWrite(call)) return undefined;
      const token = /\/webhooks\/[^/]+\/([^/]+)\/messages\/@original$/u.exec(call.method)?.[1];
      return {
        id: (call.response as { readonly id: string }).id,
        links: linkTargets((call.body as { readonly components?: unknown }).components),
        onlyPerson:
          (token !== undefined && ephemeralTokens.has(token)) ||
          (((call.body as { readonly flags?: number }).flags ?? 0) & EPHEMERAL_FLAG) !== 0,
        options: choicesOf(call),
        text: (call.body as { readonly content?: string }).content ?? "",
      };
    },
    shownReply(body) {
      // A message answering an interaction; with the ephemeral flag, only the presser sees it.
      const reply = body as {
        readonly data?: {
          readonly components?: unknown;
          readonly content?: string;
          readonly flags?: number;
        };
        readonly type?: number;
      };
      if (reply.type !== 4 || reply.data === undefined) return undefined;
      return {
        id: "",
        links: linkTargets(reply.data.components),
        onlyPerson: ((reply.data.flags ?? 0) & 64) !== 0,
        options: [],
        text: reply.data.content ?? "",
      };
    },
    personShownAs: [`<@${PERSON.id}>`, PERSON.username],
    press(option, person: Person) {
      const handle = option.handle as PressHandle;
      const id = nextInteraction();
      if (handle.customId.startsWith("eve_auth:")) {
        // eve answers a sign-in press with an ephemeral deferred response, a new message.
        ephemeralTokens.add(`tok-${id}`);
      } else {
        // A component interaction's `@original` response is the message holding the component.
        originals.set(`tok-${id}`, handle.messageId);
      }
      return signed(
        JSON.stringify({
          application_id: "APP1",
          channel_id: conversationChannel(),
          data:
            handle.value === undefined
              ? { component_type: 2, custom_id: handle.customId }
              : { component_type: 3, custom_id: handle.customId, values: [handle.value] },
          id,
          ...where(PEOPLE[person]),
          message: { content: handle.content, id: handle.messageId },
          token: `tok-${id}`,
          type: 3,
          version: 1,
        }),
      );
    },
    postedText(call) {
      if (!isMessageWrite(call)) return undefined;
      return (call.body as { readonly content?: string }).content;
    },
  };
}

function choicesOf(call: PlatformCall): RenderedOption[] {
  const body = call.body as {
    readonly components?: readonly { readonly components?: readonly DiscordComponent[] }[];
    readonly content?: string;
  };
  const messageId = (call.response as { readonly id: string }).id;
  return (body.components ?? []).flatMap((row) =>
    (row.components ?? []).flatMap((component) =>
      visibleChoices(component, messageId, body.content),
    ),
  );
}

function visibleChoices(
  component: DiscordComponent,
  messageId: string,
  content: string | undefined,
): RenderedOption[] {
  if (component.custom_id === undefined) return [];
  const customId = component.custom_id;
  if (component.type === 2 && component.label !== undefined) {
    return [
      { handle: { content, customId, messageId } satisfies PressHandle, label: component.label },
    ];
  }
  if (component.type === 3) {
    return (component.options ?? []).map((option) => ({
      handle: { content, customId, messageId, value: option.value } satisfies PressHandle,
      label: option.label,
    }));
  }
  return [];
}

/**
 * Any call that writes a message a person sees. eve edits the interaction's
 * original response first, then sends follow-ups, and falls back to a plain
 * channel message when the interaction token fails.
 */
function isMessageWrite(call: PlatformCall): boolean {
  return (
    /^(PATCH|POST) /u.test(call.method) &&
    !call.method.endsWith("/typing") &&
    !call.method.endsWith("/threads")
  );
}
