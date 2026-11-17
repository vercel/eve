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
    readonly inlines?: readonly { readonly text?: string }[];
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
  readonly activityId: string;
  readonly data: Record<string, unknown>;
  readonly execute: boolean;
  readonly value?: string;
}

export function teamsDriver(surface: Exclude<Surface, "public"> = "shared"): ChannelDriver {
  const personal = surface === "private";
  nextConversation += 1;
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
  const uploads = new Map<string, SentFile>();

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
    const id = request.method === "PUT" ? path.split("/").at(-1)! : nextActivityId();
    return { body, method: `${request.method} ${path}`, response: { id } };
  }

  return {
    name: personal ? "teams-dm" : "teams",
    personId: PERSON.id,
    capabilities: personal
      ? ["attachments", "buttons", "text-replies"]
      : ["attachments", "another-person", "buttons", "text-replies"],
    surface,
    createChannel: (record) =>
      teamsChannel({
        api: { fetch: recordingFetch(record, decode) },
        credentials: { tokenProvider: () => "test-token", webhookVerifier: () => true },
      }),
    message: (text, person, files = []) =>
      personal
        ? activity({ attachments: attached(files), from: PEOPLE[person], text, type: "message" })
        : activity({
            attachments: attached(files),
            entities: [{ mentioned: BOT, text: MENTION, type: "mention" }],
            from: PEOPLE[person],
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
      return {
        id: activityIdOf(call),
        links: linkTargets(adaptiveCard(body)?.actions),
        options: cardOptions(call),
        text: [body.text ?? "", cardText(adaptiveCard(body))].join("\n"),
      };
    },
    shownReply(body) {
      const reply = body as { readonly type?: string; readonly value?: unknown };
      if (reply.type === "application/vnd.microsoft.activity.message") {
        return { id: "", onlyPerson: true, options: [], text: String(reply.value ?? "") };
      }
      if (reply.type !== "application/vnd.microsoft.card.adaptive") return undefined;
      const card = reply.value as AdaptiveCard;
      return {
        id: "",
        links: linkTargets(card.actions),
        onlyPerson: true,
        options: [],
        text: cardText(card),
      };
    },
    personShownAs: [PERSON.name],
    press: (option: RenderedOption, person: Person) => {
      const { activityId: cardActivityId, data, execute, value } = option.handle as PressHandle;
      const submitted = value === undefined ? data : { ...data, eve_option: value };
      if (execute) {
        return activity({
          from: PEOPLE[person],
          id: `INVOKE-${activityId + 1}`,
          name: "adaptiveCard/action",
          replyToId: cardActivityId,
          type: "invoke",
          value: { action: { data: submitted } },
        });
      }
      return activity({
        from: PEOPLE[person],
        replyToId: cardActivityId,
        type: "message",
        value: submitted,
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

function cardText(card: AdaptiveCard | undefined): string {
  return (card?.body ?? [])
    .flatMap((element) => {
      if (element.type === "TextBlock" && element.text !== undefined) return [element.text];
      if (element.type !== "RichTextBlock") return [];
      return [(element.inlines ?? []).map((inline) => inline.text ?? "").join("")];
    })
    .join("\n");
}

function cardOptions(call: PlatformCall): RenderedOption[] {
  const card = adaptiveCard(call.body as ActivityBody);
  const activityId = activityIdOf(call);
  const choiceSet = card?.body?.find((element) => element.type === "Input.ChoiceSet");
  const submits = (card?.actions ?? []).filter(
    (action) =>
      (action.type === "Action.Submit" || action.type === "Action.Execute") &&
      action.data !== undefined,
  );
  if (choiceSet?.choices !== undefined) {
    const submit = submits[0];
    if (submit?.data === undefined) return [];
    const { data } = submit;
    const execute = submit.type === "Action.Execute";
    return choiceSet.choices.map((choice) => ({
      handle: { activityId, data, execute, value: choice.value } satisfies PressHandle,
      label: choice.title,
    }));
  }
  return submits.map((action) => ({
    handle: {
      activityId,
      data: action.data!,
      execute: action.type === "Action.Execute",
    } satisfies PressHandle,
    label: action.title ?? "",
  }));
}
