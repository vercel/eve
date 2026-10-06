import { teamsChannel } from "#public/channels/teams/index.js";
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

let nextConversation = 0;
const TENANT = "TENANT";
const PERSON = { id: "USER", name: "Alice" } as const;
const PEOPLE = { alice: PERSON, bob: { id: "USER-BOB", name: "Bob" } } as const;
const BOT = { id: "BOT", name: "eve Bot" } as const;
const SERVICE_URL = "https://smba.example.test/teams";
const MENTION = `<at>${BOT.name}</at>`;

interface Choice {
  readonly title: string;
  readonly value: string;
}

interface AdaptiveCard {
  readonly body?: readonly {
    readonly choices?: readonly Choice[];
    readonly text?: string;
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
  /** The card's activity, which Teams names as `replyToId` on the press. */
  readonly activityId: string;
  readonly data: Record<string, unknown>;
  /** The chosen ChoiceSet value; unset when each option is its own Submit action. */
  readonly value?: string;
}

/**
 * Drives Teams' Bot Framework webhook and Connector API, in a team channel's
 * thread by default or in a personal chat.
 */
export function teamsDriver(surface: Exclude<Surface, "public"> = "shared"): ChannelDriver {
  const personal = surface === "private";
  // Conversation ids are part of Teams' continuation token, so isolate each driver instance.
  nextConversation += 1;
  // A channel thread's conversation id names the post that started it.
  const conversationId = personal
    ? `CONV-${nextConversation}`
    : `CONV-${nextConversation};messageid=MSG-1`;
  const conversation = personal
    ? { conversationType: "personal", id: conversationId }
    : { conversationType: "channel", id: conversationId };
  const channelData = personal
    ? { tenant: { id: TENANT } }
    : { channel: { id: "CHANNEL" }, team: { id: "TEAM" }, tenant: { id: TENANT } };
  let activityId = 0;
  /** Files a person sent, by the URL Teams lists each under. */
  const uploads = new Map<string, SentFile>();

  /**
   * A person's files as Teams attaches them: an image pasted into the message as
   * a Bot Connector `contentUrl`, and any other file as an upload with a
   * pre-authenticated SharePoint `downloadUrl`.
   */
  function attached(files: readonly SentFile[]): Record<string, unknown>[] {
    return files.map((file) => {
      const id = `${conversationId}-${uploads.size + 1}`.replaceAll(/[^\w-]/gu, "");
      if (file.mediaType.startsWith("image/")) {
        const url = `https://smba.trafficmanager.net/amer/v3/attachments/${id}/views/original`;
        uploads.set(url, file);
        return { contentType: file.mediaType, contentUrl: url, name: file.name };
      }
      const url = `https://contoso.sharepoint.com/personal/alice/${id}/${file.name}?tempauth=signed`;
      uploads.set(url, file);
      return {
        content: { downloadUrl: url, fileType: file.name.split(".").at(-1), uniqueId: id },
        contentType: "application/vnd.microsoft.teams.file.download.info",
        name: file.name,
      };
    });
  }

  function nextActivityId(): string {
    activityId += 1;
    return `ACT-${activityId}`;
  }

  function activity(payload: Record<string, unknown>): Request {
    return new Request("https://agent.example.com/eve/v1/teams", {
      body: JSON.stringify({
        channelData,
        conversation,
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
    const url = new URL(request.url);
    if (uploads.has(url.href)) {
      // Bot Connector attachments need the bot's token; a SharePoint download URL carries its own.
      const authorized =
        url.hostname !== "smba.trafficmanager.net" ||
        request.headers.get("authorization") === "Bearer test-token";
      return {
        body: {},
        method: `GET ${url.pathname}`,
        response: authorized
          ? serveFile(uploads.get(url.href))
          : new Response("Unauthorized", { status: 401 }),
      };
    }
    const bodyText = await request.text();
    const body = bodyText === "" ? {} : JSON.parse(bodyText);
    const path = new URL(request.url).pathname;
    // An update keeps the id of the activity it replaces.
    const id = request.method === "PUT" ? path.split("/").at(-1)! : nextActivityId();
    return { body, method: `${request.method} ${path}`, response: { id } };
  }

  return {
    name: personal ? "teams-dm" : "teams",
    capabilities: personal
      ? ["attachments", "buttons", "text-replies"]
      : ["attachments", "another-person", "buttons", "text-replies"],
    surface,
    createChannel: (record) =>
      teamsChannel({
        api: { fetch: recordingFetch(record, decode) },
        credentials: { tokenProvider: () => "test-token", webhookVerifier: () => true },
      }),
    message: (text, files = []) =>
      personal
        ? activity({ attachments: attached(files), text, type: "message" })
        : // In a channel the default policy hears only mentions, so a person mentions the bot
          // each time, on its own line so the test model's line-based directives still read it.
          activity({
            attachments: attached(files),
            entities: [{ mentioned: BOT, text: MENTION, type: "mention" }],
            text: `${text}\n${MENTION}`,
            textFormat: "xml",
            type: "message",
          }),
    findOptions(call, prompt) {
      const body = call.body as ActivityBody;
      if (body.type !== "message" || !body.text?.includes(prompt)) return undefined;
      return cardOptions(call);
    },
    shownMessage(call) {
      const body = call.body as ActivityBody;
      if (body.type !== "message") return undefined;
      const texts = (adaptiveCard(body)?.body ?? []).flatMap((element) =>
        element.type === "TextBlock" && element.text !== undefined ? [element.text] : [],
      );
      return {
        id: activityIdOf(call),
        links: linkTargets(adaptiveCard(body)?.actions),
        options: cardOptions(call),
        text: [body.text ?? "", ...texts].join("\n"),
      };
    },
    personShownAs: [PERSON.name],
    press: (option: RenderedOption, person: Person) => {
      const { activityId: cardActivityId, data, value } = option.handle as PressHandle;
      return activity({
        from: PEOPLE[person],
        id: `INVOKE-${activityId + 1}`,
        name: "adaptiveCard/action",
        replyToId: cardActivityId,
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

function activityIdOf(call: PlatformCall): string {
  return (call.response as { readonly id: string }).id;
}

function adaptiveCard(body: ActivityBody): AdaptiveCard | undefined {
  return body.attachments?.find(
    (attachment) => attachment.contentType === "application/vnd.microsoft.card.adaptive",
  )?.content;
}

function cardOptions(call: PlatformCall): RenderedOption[] {
  const card = adaptiveCard(call.body as ActivityBody);
  const activityId = activityIdOf(call);
  const choiceSet = card?.body?.find((element) => element.type === "Input.ChoiceSet");
  const submits = (card?.actions ?? []).filter(
    (action) => action.type === "Action.Submit" && action.data !== undefined,
  );
  // A select renders one ChoiceSet and a single Submit; other choices are one Submit each.
  if (choiceSet?.choices !== undefined) {
    const data = submits[0]?.data;
    if (data === undefined) return [];
    return choiceSet.choices.map((choice) => ({
      handle: { activityId, data, value: choice.value } satisfies PressHandle,
      label: choice.title,
    }));
  }
  return submits.map((action) => ({
    handle: { activityId, data: action.data! } satisfies PressHandle,
    label: action.title ?? "",
  }));
}
