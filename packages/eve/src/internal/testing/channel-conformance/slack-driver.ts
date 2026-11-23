import { createHmac } from "node:crypto";

import { type SlackChannelConfig, slackChannel } from "#public/channels/slack/index.js";
import { ANSWER_ACTION_PREFIX } from "#public/channels/slack/hitl.js";
import { SIGN_IN_CANCEL_ACTION_ID } from "#public/channels/slack/sign-in-cancel.js";
import {
  type ChannelDriver,
  type Person,
  type Surface,
  type PlatformCall,
  type RenderedOption,
  recordingFetch,
  linkTargets,
  type SentFile,
  serveFile,
} from "#internal/testing/channel-conformance/harness.js";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";

const SIGNING_SECRET = "slack-conformance-secret";
const PERSON = "U_ALICE";
const BOT = "U_EVE";
const PEOPLE = {
  alice: { id: PERSON, name: "alice" },
  bob: { id: "U_BOB", name: "bob" },
} as const;
let nextChannel = 0;
const TEAM = "T01";
const RESPONSE_URL_HOST = "hooks.slack.com";

interface SlackText {
  readonly text: string;
  readonly type: string;
}

interface SlackOption {
  readonly text: SlackText;
  readonly value: string;
}

interface SlackElement {
  readonly action_id?: string;
  readonly options?: readonly SlackOption[];
  readonly text?: SlackText;
  readonly type: string;
  readonly value?: string;
}

interface PressHandle {
  readonly action: Record<string, unknown>;
  readonly blocks: readonly unknown[];
  readonly messageTs: string;
}

interface ResponseUrlBody {
  readonly delete_original?: boolean;
  readonly message_ts: string;
}

interface SlackMessageBody {
  readonly blocks?: readonly unknown[];
  readonly channel?: string;
  readonly markdown_text?: string;
  readonly text?: string;
  readonly ts?: string;
}

export function slackDriver(
  conversation: Exclude<Surface, "public"> | "code-channel" = "shared",
  config: Pick<SlackChannelConfig, "onAnswers" | "renderers"> = {},
): ChannelDriver {
  const dm = conversation === "private";
  const codeChannel = conversation === "code-channel";
  const surface: Surface = dm ? "private" : "shared";
  nextChannel += 1;
  const CHANNEL = `${dm ? "D" : codeChannel ? "C_CODE" : "C"}${String(nextChannel).padStart(3, "0")}`;
  let sequence = 0;
  const threadTs = "1700000000.000001";
  let threadStarted = false;
  let restoreFetch: (() => void) | undefined;

  function nextTs(): string {
    sequence += 1;
    return `1700000001.${String(sequence).padStart(6, "0")}`;
  }

  function signed(body: string, contentType: string): Request {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    return new Request("https://agent.example.com/eve/v1/slack", {
      body,
      headers: {
        "content-type": contentType,
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": signature,
      },
      method: "POST",
    });
  }

  const uploads = new Map<string, SentFile>();
  function slackFile(file: SentFile) {
    const id = `F${uploads.size + 1}`;
    const url = `https://files.slack.com/files-pri/${TEAM}-${id}/${file.name}`;
    uploads.set(url, file);
    return {
      id,
      mimetype: file.mediaType,
      name: file.name,
      size: file.bytes.length,
      url_private: url,
    };
  }

  async function decode(request: Request): Promise<PlatformCall> {
    const url = new URL(request.url);
    if (url.hostname === "files.slack.com") {
      return {
        body: {},
        method: `GET ${url.pathname}`,
        response: serveFile(uploads.get(url.href)),
      };
    }
    const method = url.pathname.split("/").at(-1)!;
    const body = decodeSlackApiBody(await request.text(), request.headers.get("content-type"));
    const ts = nextTs();
    if (codeChannel && method === "conversations.info") {
      return {
        body,
        method,
        response: {
          channel: {
            id: CHANNEL,
            is_private: false,
            properties: { record_channel: { record_type: "agent_channel" } },
          },
          ok: true,
        },
      };
    }
    if (
      codeChannel &&
      method.startsWith("chat.") &&
      (body as { thread_ts?: unknown }).thread_ts !== undefined
    ) {
      return { body, method, response: { error: "thread_not_found", ok: false } };
    }
    return {
      body,
      method,
      response: {
        bot_id: "B_EVE",
        channel: CHANNEL,
        message: { ts },
        messages: [],
        ok: true,
        team_id: TEAM,
        ts,
        user_id: BOT,
      },
    };
  }

  return {
    name: dm ? "slack-dm" : codeChannel ? "slack-code-channel" : "slack",
    personId: PERSON,
    space: {
      id: `slack:${TEAM}:${CHANNEL}`,
      type: dm ? "direct" : "shared",
      visibility: dm ? "private" : "public",
      workspaceId: `slack:${TEAM}`,
    },
    capabilities: dm
      ? ["attachments", "buttons", "sign-in-cancel", "text-replies"]
      : ["attachments", "another-person", "buttons", "sign-in-cancel", "text-replies"],
    surface,
    createChannel(record) {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.hostname !== RESPONSE_URL_HOST) return await previousFetch(input, init);
        record({
          body: {
            ...((await request.json()) as Record<string, unknown>),
            message_ts: url.pathname.split("/").at(-2),
          },
          method: "response_url",
          response: { ok: true },
        });
        return new Response("ok");
      };
      restoreFetch = () => {
        globalThis.fetch = previousFetch;
        restoreFetch = undefined;
      };
      return slackChannel({
        ...config,
        api: { fetch: recordingFetch(record, decode) },
        credentials: { botToken: "xoxb-conformance", signingSecret: SIGNING_SECRET },
        ...(codeChannel && { codeChannels: true }),
      });
    },
    dispose() {
      restoreFetch?.();
    },
    message: (text, person, files = []) => {
      const ts = threadStarted ? nextTs() : threadTs;
      const thread = threadStarted && !codeChannel ? { thread_ts: threadTs } : {};
      threadStarted = true;
      const event = dm
        ? { channel_type: "im", text, type: "message" }
        : codeChannel
          ? { channel_type: "channel", text, type: "message" }
          : { channel_type: "channel", text: `${text}\n<@${BOT}>`, type: "app_mention" };
      const shared: Record<string, unknown> = {};
      if (files.length > 0) {
        shared.files = files.map(slackFile);
        if (dm) shared.subtype = "file_share";
      }
      return signed(
        JSON.stringify({
          event: {
            ...thread,
            ...event,
            ...shared,
            channel: CHANNEL,
            event_ts: ts,
            ts,
            user: PEOPLE[person].id,
          },
          authorizations: [
            { is_bot: true, is_enterprise_install: false, team_id: TEAM, user_id: BOT },
          ],
          event_id: `Ev${ts}`,
          team_id: TEAM,
          type: "event_callback",
        }),
        "application/json",
      );
    },
    findOptions(call, prompt) {
      const body = call.body as SlackMessageBody;
      if (!isMessageWrite(call) || body.blocks === undefined) return undefined;
      if (!JSON.stringify(body.blocks).includes(prompt)) return undefined;
      const messageTs = messageTsOf(call);
      const card = hitlOptions(
        body.blocks.filter((block) => JSON.stringify(block).includes(prompt)),
        messageTs,
        body.blocks,
      );
      return card.length > 0 ? card : hitlOptions(body.blocks, messageTs);
    },
    shownMessage(call) {
      const responded = call.body as ResponseUrlBody;
      if (call.method === "response_url" && responded.delete_original === true) {
        return { id: responded.message_ts, options: [], removed: true, text: "" };
      }
      if (!isMessageWrite(call)) return undefined;
      const body = call.body as SlackMessageBody;
      const id = messageTsOf(call);
      return {
        id,
        links: linkTargets(body.blocks ?? []),
        onlyPerson:
          call.method === "chat.postEphemeral" ||
          (body.channel !== CHANNEL && /^[DU]/u.test(body.channel ?? "")),
        options: hitlOptions(body.blocks ?? [], id),
        text: [body.markdown_text ?? body.text ?? "", ...blockTexts(body.blocks ?? [])].join("\n"),
      };
    },
    personShownAs: [`<@${PERSON}>`],
    press: (option, person: Person) => {
      const { action, blocks, messageTs } = option.handle as PressHandle;
      const { id, name } = PEOPLE[person];
      const payload = {
        actions: [action],
        channel: { id: CHANNEL },
        message: { blocks, ...(!codeChannel && { thread_ts: threadTs }), ts: messageTs },
        response_url: `https://${RESPONSE_URL_HOST}/actions/${TEAM}/${messageTs}/conformance`,
        team: { id: TEAM },
        type: "block_actions",
        user: { id, name, team_id: TEAM, username: name },
      };
      return signed(
        new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
        "application/x-www-form-urlencoded",
      );
    },
    postedText(call: PlatformCall) {
      if (!call.method.startsWith("chat.")) return undefined;
      const body = call.body as {
        readonly chunks?: readonly { readonly text?: string }[];
        readonly markdown_text?: string;
        readonly text?: string;
      };
      return (
        body.markdown_text ?? body.text ?? body.chunks?.map((chunk) => chunk.text ?? "").join("")
      );
    },
  };
}

function isMessageWrite(call: PlatformCall): boolean {
  return (
    call.method === "chat.postMessage" ||
    call.method === "chat.postEphemeral" ||
    call.method === "chat.update"
  );
}

function messageTsOf(call: PlatformCall): string {
  return call.method === "chat.update"
    ? (call.body as SlackMessageBody).ts!
    : (call.response as { readonly ts: string }).ts;
}

function hitlOptions(
  blocks: readonly unknown[],
  messageTs: string,
  messageBlocks: readonly unknown[] = blocks,
): RenderedOption[] {
  return hitlElements(blocks).flatMap((element) =>
    renderedOptions(element, messageBlocks, messageTs),
  );
}

function hitlElements(value: unknown): SlackElement[] {
  if (Array.isArray(value)) return value.flatMap(hitlElements);
  if (typeof value !== "object" || value === null) return [];
  const element = value as SlackElement;
  if (element.action_id?.startsWith(ANSWER_ACTION_PREFIX) === true) return [element];
  if (element.action_id === SIGN_IN_CANCEL_ACTION_ID) return [element];
  return Object.values(value).flatMap(hitlElements);
}

function blockTexts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(blockTexts);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "text" && typeof child === "string" ? [child] : blockTexts(child),
  );
}

function renderedOptions(
  element: SlackElement,
  blocks: readonly unknown[],
  messageTs: string,
): RenderedOption[] {
  if (element.type === "button" && element.text !== undefined) {
    const action = {
      action_id: element.action_id,
      text: element.text,
      type: "button",
      value: element.value,
    };
    return [
      { handle: { action, blocks, messageTs } satisfies PressHandle, label: element.text.text },
    ];
  }
  return (element.options ?? []).map((option) => ({
    handle: {
      action: { action_id: element.action_id, selected_option: option, type: element.type },
      blocks,
      messageTs,
    } satisfies PressHandle,
    label: option.text.text,
  }));
}
