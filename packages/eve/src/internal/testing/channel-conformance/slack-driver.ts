import { createHmac } from "node:crypto";

import { slackChannel } from "#public/channels/slack/index.js";
import { HITL_ACTION_PREFIX } from "#public/channels/slack/hitl.js";
import {
  type ChannelDriver,
  type PlatformCall,
  type RenderedOption,
  recordingFetch,
} from "#internal/testing/channel-conformance/harness.js";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";

const SIGNING_SECRET = "slack-conformance-secret";
const PERSON = "U_ALICE";
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
  readonly action_id: string;
  readonly options?: readonly SlackOption[];
  readonly text?: SlackText;
  readonly type: string;
  readonly value?: string;
}

interface PressHandle {
  readonly action: Record<string, unknown>;
  readonly messageTs: string;
}

/** Drives the Slack channel through its Events API and interactivity webhooks in a DM. */
export function slackDriver(): ChannelDriver {
  // A fresh DM per driver keeps each test's session apart in the shared workflow world.
  nextChannel += 1;
  const CHANNEL = `D${String(nextChannel).padStart(3, "0")}`;
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

  async function decode(request: Request): Promise<PlatformCall> {
    const method = new URL(request.url).pathname.split("/").at(-1)!;
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
        user_id: "U_EVE",
      },
    };
  }

  return {
    name: "slack",
    capabilities: ["buttons", "text-replies"],
    createChannel: (record) =>
      slackChannel({
        api: { fetch: recordingFetch(record, decode) },
        credentials: { botToken: "xoxb-conformance", signingSecret: SIGNING_SECRET },
      }),
    message: (text) => {
      const ts = threadStarted ? nextTs() : threadTs;
      const thread = threadStarted ? { thread_ts: threadTs } : {};
      threadStarted = true;
      return signed(
        JSON.stringify({
          event: {
            ...thread,
            channel: CHANNEL,
            channel_type: "im",
            event_ts: ts,
            text,
            ts,
            type: "message",
            user: PERSON,
          },
          event_id: `Ev${ts}`,
          team_id: TEAM,
          type: "event_callback",
        }),
        "application/json",
      );
    },
    findOptions(call, prompt) {
      if (call.method !== "chat.postMessage" && call.method !== "chat.update") return undefined;
      const body = call.body as { readonly blocks?: readonly unknown[] };
      if (body.blocks === undefined || !JSON.stringify(body.blocks).includes(prompt))
        return undefined;
      const messageTs = (call.response as { readonly ts: string }).ts;
      const options = body.blocks.flatMap((block) =>
        // Questions use `actions` blocks (`elements`); approval cards keep buttons in `actions`.
        (
          (block as { readonly elements?: readonly SlackElement[] }).elements ??
          (block as { readonly actions?: readonly SlackElement[] }).actions ??
          []
        )
          .filter((element) => element.action_id.startsWith(HITL_ACTION_PREFIX))
          .flatMap((element) => renderedOptions(element, messageTs)),
      );
      return options;
    },
    press: (option) => {
      const { action, messageTs } = option.handle as PressHandle;
      const payload = {
        actions: [action],
        channel: { id: CHANNEL },
        message: { thread_ts: threadTs, ts: messageTs },
        team: { id: TEAM },
        type: "block_actions",
        user: { id: PERSON, name: "alice", team_id: TEAM, username: "alice" },
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

function renderedOptions(element: SlackElement, messageTs: string): RenderedOption[] {
  if (element.type === "button" && element.text !== undefined) {
    const action = {
      action_id: element.action_id,
      text: element.text,
      type: "button",
      value: element.value,
    };
    return [{ handle: { action, messageTs } satisfies PressHandle, label: element.text.text }];
  }
  return (element.options ?? []).map((option) => ({
    handle: {
      action: { action_id: element.action_id, selected_option: option, type: element.type },
      messageTs,
    } satisfies PressHandle,
    label: option.text.text,
  }));
}
