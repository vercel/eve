import { createHmac } from "node:crypto";

import { slackChannel } from "#public/channels/slack/index.js";
import { HITL_ACTION_PREFIX } from "#public/channels/slack/hitl.js";
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

interface SlackText {
  readonly text: string;
  readonly type: string;
}

interface SlackOption {
  readonly text: SlackText;
  readonly value: string;
}

/** The HITL widgets eve renders: one button per option, or one single-click radio/select. */
interface SlackElement {
  readonly action_id?: string;
  readonly options?: readonly SlackOption[];
  readonly text?: SlackText;
  readonly type: string;
  readonly value?: string;
}

interface PressHandle {
  readonly action: Record<string, unknown>;
  /** The pressed message's blocks, which Slack echoes in every `block_actions` payload. */
  readonly blocks: readonly unknown[];
  readonly messageTs: string;
}

interface SlackMessageBody {
  readonly blocks?: readonly unknown[];
  /** Replies post Markdown here, with `text` as the plain fallback. */
  readonly markdown_text?: string;
  readonly text?: string;
  readonly ts?: string;
}

/**
 * Drives the Slack channel through its Events API and interactivity webhooks,
 * in a public channel thread by default or in a DM.
 */
export function slackDriver(surface: Exclude<Surface, "public"> = "shared"): ChannelDriver {
  const dm = surface === "private";
  // A fresh channel per driver keeps each test's session apart in the shared workflow world.
  nextChannel += 1;
  const CHANNEL = `${dm ? "D" : "C"}${String(nextChannel).padStart(3, "0")}`;
  let sequence = 0;
  // Every message is a reply in the thread the first one starts.
  const threadTs = "1700000000.000001";
  let threadStarted = false;

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

  /** Files a person uploaded, by the `url_private` Slack downloads each from. */
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
    name: dm ? "slack-dm" : "slack",
    capabilities: dm
      ? ["attachments", "buttons", "text-replies"]
      : ["attachments", "another-person", "buttons", "text-replies"],
    surface,
    createChannel: (record) =>
      slackChannel({
        api: { fetch: recordingFetch(record, decode) },
        credentials: { botToken: "xoxb-conformance", signingSecret: SIGNING_SECRET },
      }),
    message: (text, person, files = []) => {
      const ts = threadStarted ? nextTs() : threadTs;
      const thread = threadStarted ? { thread_ts: threadTs } : {};
      threadStarted = true;
      // In a channel the default policy hears only mentions, so a person mentions the bot each
      // time. On its own line, so the test model's line-based directives still read the message.
      const event = dm
        ? { channel_type: "im", text, type: "message" }
        : { channel_type: "channel", text: `${text}\n<@${BOT}>`, type: "app_mention" };
      // A message with uploads is a `file_share` in a DM; a mention carries its files as is.
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
          // Slack names the installation that received the event, which is how eve knows its
          // own bot user, e.g. to strip that mention from a typed answer.
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
      // A batch of approvals posts one card per request, each holding its own buttons.
      const card = hitlOptions(
        body.blocks.filter((block) => JSON.stringify(block).includes(prompt)),
        messageTs,
        body.blocks,
      );
      return card.length > 0 ? card : hitlOptions(body.blocks, messageTs);
    },
    shownMessage(call) {
      if (!isMessageWrite(call)) return undefined;
      const body = call.body as SlackMessageBody;
      const id = messageTsOf(call);
      return {
        id,
        links: linkTargets(body.blocks ?? []),
        onlyPerson: call.method === "chat.postEphemeral",
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
        message: { blocks, thread_ts: threadTs, ts: messageTs },
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

/** A message write a person sees; an ephemeral one only they see, such as a private sign-in. */
function isMessageWrite(call: PlatformCall): boolean {
  return (
    call.method === "chat.postMessage" ||
    call.method === "chat.postEphemeral" ||
    call.method === "chat.update"
  );
}

/** A post's ts comes back from Slack; an update names the ts it rewrites. */
function messageTsOf(call: PlatformCall): string {
  return call.method === "chat.update"
    ? (call.body as SlackMessageBody).ts!
    : (call.response as { readonly ts: string }).ts;
}

/** HITL buttons in `blocks`, each pressed as part of the whole message `messageBlocks`. */
function hitlOptions(
  blocks: readonly unknown[],
  messageTs: string,
  messageBlocks: readonly unknown[] = blocks,
): RenderedOption[] {
  return blocks.flatMap((block) =>
    // Questions use `actions` blocks (`elements`); approval cards keep buttons in `actions`.
    (
      (block as { readonly elements?: readonly SlackElement[] }).elements ??
      (block as { readonly actions?: readonly SlackElement[] }).actions ??
      []
    )
      .filter((element) => element.action_id?.startsWith(HITL_ACTION_PREFIX) === true)
      .flatMap((element) => renderedOptions(element, messageBlocks, messageTs)),
  );
}

/** Every `text` string in Block Kit, wherever a block nests it. */
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
