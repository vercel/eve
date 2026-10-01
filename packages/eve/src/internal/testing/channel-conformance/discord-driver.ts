import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { discordChannel } from "#public/channels/discord/index.js";
import {
  type ChannelDriver,
  type PlatformCall,
  type RenderedOption,
  recordingFetch,
} from "#internal/testing/channel-conformance/harness.js";

let nextChannel = 0;

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

/** Drives Discord's signed application-command and component interaction webhooks. */
export function discordDriver(): ChannelDriver {
  nextChannel += 1;
  const channelId = `C_CONFORMANCE_${nextChannel}`;
  const { privateKey, publicKeyHex } = testKeys();
  let interactionId = 0;
  let messageId = 0;

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
    const text = await request.text();
    const body = text === "" ? {} : JSON.parse(text);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/typing")) {
      return { body, method: `POST ${path}`, response: {} };
    }
    messageId += 1;
    return {
      body,
      method: `${request.method} ${path}`,
      response: { channel_id: channelId, id: `M_CONFORMANCE_${messageId}` },
    };
  }

  function nextInteraction(): string {
    interactionId += 1;
    return `I_CONFORMANCE_${interactionId}`;
  }

  return {
    name: "discord",
    capabilities: ["buttons"],
    createChannel: (record) =>
      discordChannel({
        api: { fetch: recordingFetch(record, decode) },
        credentials: { applicationId: "APP1", botToken: "bot-token", publicKey: publicKeyHex },
      }),
    message: (text) => {
      const id = nextInteraction();
      return signed(
        JSON.stringify({
          application_id: "APP1",
          channel: { type: 1 },
          channel_id: channelId,
          data: { name: "ask", options: [{ name: "message", type: 3, value: text }] },
          id,
          token: `tok-${id}`,
          type: 2,
          user: { id: "U_CONFORMANCE", username: "alice" },
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
      const messageId = (call.response as { readonly id?: string }).id ?? "";
      return (body.components ?? []).flatMap((row) =>
        (row.components ?? []).flatMap((component) => visibleChoices(component, messageId)),
      );
    },
    press(option) {
      const handle = option.handle as PressHandle;
      const id = nextInteraction();
      return signed(
        JSON.stringify({
          application_id: "APP1",
          channel_id: channelId,
          data:
            handle.value === undefined
              ? { component_type: 2, custom_id: handle.customId }
              : { component_type: 3, custom_id: handle.customId, values: [handle.value] },
          id,
          message: { id: handle.messageId },
          token: `tok-${id}`,
          type: 3,
          user: { id: "U_CONFORMANCE", username: "alice" },
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

function visibleChoices(component: DiscordComponent, messageId: string): RenderedOption[] {
  if (component.custom_id === undefined) return [];
  const customId = component.custom_id;
  if (component.type === 2 && component.label !== undefined) {
    return [{ handle: { customId, messageId } satisfies PressHandle, label: component.label }];
  }
  if (component.type === 3) {
    return (component.options ?? []).map((option) => ({
      handle: { customId, messageId, value: option.value } satisfies PressHandle,
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
  return /^(PATCH|POST) /u.test(call.method) && !call.method.endsWith("/typing");
}
