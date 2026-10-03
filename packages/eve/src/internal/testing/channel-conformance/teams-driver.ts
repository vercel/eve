import { teamsChannel } from "#public/channels/teams/index.js";
import {
  type ChannelDriver,
  type PlatformCall,
  type RenderedOption,
  recordingFetch,
} from "#internal/testing/channel-conformance/harness.js";

let nextConversation = 0;
const TENANT = "TENANT";
const PERSON = { id: "USER", name: "Alice" } as const;
const BOT = { id: "BOT", name: "eve Bot" } as const;
const SERVICE_URL = "https://smba.example.test/teams";

interface Choice {
  readonly title: string;
  readonly value: string;
}

interface AdaptiveCard {
  readonly body?: readonly {
    readonly choices?: readonly Choice[];
    readonly type?: string;
  }[];
  readonly actions?: readonly {
    readonly data?: Record<string, unknown>;
    readonly title?: string;
    readonly type?: string;
  }[];
}

interface ActivityBody {
  readonly attachments?: readonly {
    readonly content?: AdaptiveCard;
    readonly contentType?: string;
  }[];
  readonly text?: string;
  readonly type?: string;
}

interface PressHandle {
  readonly data: Record<string, unknown>;
  /** The chosen ChoiceSet value; unset when each option is its own Submit action. */
  readonly value?: string;
}

/** Drives Teams' Bot Framework webhook and Connector API in a personal chat. */
export function teamsDriver(): ChannelDriver {
  // Conversation ids are part of Teams' continuation token, so isolate each driver instance.
  nextConversation += 1;
  const conversationId = `CONV-${nextConversation}`;
  let activityId = 0;

  function nextActivityId(): string {
    activityId += 1;
    return `ACT-${activityId}`;
  }

  function activity(payload: Record<string, unknown>): Request {
    return new Request("https://agent.example.com/eve/v1/teams", {
      body: JSON.stringify({
        channelData: { tenant: { id: TENANT } },
        conversation: { id: conversationId, conversationType: "personal" },
        from: PERSON,
        id: `MSG-${activityId + 1}`,
        recipient: BOT,
        serviceUrl: SERVICE_URL,
        ...payload,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  async function decode(request: Request): Promise<PlatformCall> {
    const bodyText = await request.text();
    const body = bodyText === "" ? {} : JSON.parse(bodyText);
    return {
      body,
      method: new URL(request.url).pathname.split("/").at(-1) ?? "",
      response: { id: nextActivityId() },
    };
  }

  return {
    name: "teams",
    capabilities: ["buttons", "text-replies"],
    createChannel: (record) =>
      teamsChannel({
        api: { fetch: recordingFetch(record, decode) },
        credentials: { tokenProvider: () => "test-token", webhookVerifier: () => true },
      }),
    message: (text) => activity({ text, type: "message" }),
    findOptions(call, prompt) {
      const body = call.body as ActivityBody;
      if (body.type === "typing" || body.type !== "message" || !body.text?.includes(prompt)) {
        return undefined;
      }
      const card = body.attachments?.find(
        (attachment) => attachment.contentType === "application/vnd.microsoft.card.adaptive",
      )?.content;
      const choiceSet = card?.body?.find((element) => element.type === "Input.ChoiceSet");
      const submits = (card?.actions ?? []).filter(
        (action) => action.type === "Action.Submit" && action.data !== undefined,
      );
      // A select renders one ChoiceSet and a single Submit; other choices are one Submit each.
      if (choiceSet?.choices !== undefined) {
        const data = submits[0]?.data;
        if (data === undefined) return [];
        return choiceSet.choices.map((choice) => ({
          handle: { data, value: choice.value } satisfies PressHandle,
          label: choice.title,
        }));
      }
      return submits.map((action) => ({
        handle: { data: action.data! } satisfies PressHandle,
        label: action.title ?? "",
      }));
    },
    press: (option: RenderedOption) => {
      const { data, value } = option.handle as PressHandle;
      return activity({
        id: `INVOKE-${activityId + 1}`,
        name: "adaptiveCard/action",
        type: "invoke",
        value: { action: { data: value === undefined ? data : { ...data, eve_option: value } } },
      });
    },
    postedText(call) {
      const body = call.body as ActivityBody;
      if (body.type === "typing") return undefined;
      return body.type === "message" ? body.text : undefined;
    },
  };
}
