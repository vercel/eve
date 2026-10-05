import {
  type ChannelDriver,
  type PlatformCall,
  type RenderedOption,
  recordingFetch,
  linkTargets,
  type SentFile,
  serveFile,
} from "#internal/testing/channel-conformance/harness.js";
import { linearChannel } from "#public/channels/linear/index.js";
import { signLinearWebhookBody } from "#public/channels/linear/verify.js";

const SECRET = "linear-conformance-secret";
let nextConversation = 0;

/** Drives Linear Agent Session webhooks and Agent Activity GraphQL mutations. */
// Anyone in the workspace can reply in an issue's agent session.
const PEOPLE = { alice: "user_1", bob: "user_2" } as const;

export function linearDriver(): ChannelDriver {
  nextConversation += 1;
  const sessionId = `agent-session-conformance-${nextConversation}`;
  const issueId = `issue-conformance-${nextConversation}`;
  const issueIdentifier = `EVE-${nextConversation}`;
  let delivery = 0;
  let activity = 0;

  function webhook(payload: Record<string, unknown>): Request {
    const body = JSON.stringify({
      type: "AgentSessionEvent",
      webhookTimestamp: Date.now(),
      organizationId: "org_1",
      appUserId: "app_user_1",
      ...payload,
    });
    delivery += 1;
    return new Request("https://agent.example.com/eve/v1/linear", {
      body,
      headers: {
        "content-type": "application/json",
        "linear-delivery": `delivery-${delivery}`,
        "linear-event": "AgentSessionEvent",
        "linear-signature": signLinearWebhookBody(body, SECRET),
      },
      method: "POST",
    });
  }

  /** Files a person uploaded, by the `uploads.linear.app` URL their Markdown links to. */
  const uploads = new Map<string, SentFile>();
  /** A person's words with each file inlined as Linear writes an upload: an image or a link. */
  function withUploads(text: string, files: readonly SentFile[]): string {
    const links = files.map((file) => {
      const url = `https://uploads.linear.app/conformance/${uploads.size + 1}/${file.name}`;
      uploads.set(url, file);
      return `${file.mediaType.startsWith("image/") ? "!" : ""}[${file.name}](${url})`;
    });
    return [text, ...links].join("\n\n");
  }

  async function decode(request: Request): Promise<PlatformCall> {
    if (new URL(request.url).hostname === "uploads.linear.app") {
      return {
        body: {},
        method: `GET ${request.url}`,
        response: serveFile(uploads.get(request.url)),
      };
    }
    const body = JSON.parse(await request.text()) as {
      readonly query?: string;
      readonly variables?: unknown;
    };
    activity += 1;
    return {
      body,
      method: body.query?.includes("AgentActivityCreate") ? "AgentActivityCreate" : "GraphQL",
      response: {
        data: {
          agentActivityCreate: {
            agentActivity: { id: `activity-${activity}` },
            success: true,
          },
        },
      },
    };
  }

  return {
    name: "linear",
    capabilities: ["another-person", "attachments", "text-replies"],
    // An agent session lives on an issue the whole workspace can see.
    surface: "shared",
    createChannel: (record) =>
      linearChannel({
        api: { fetch: recordingFetch(record, decode) },
        credentials: { accessToken: "linear-token", webhookSecret: SECRET },
      }),
    message: (words, person, files = []) => {
      const text = withUploads(words, files);
      const user = PEOPLE[person];
      if (delivery === 0) {
        return webhook({
          action: "created",
          agentSession: {
            creator: { id: user },
            id: sessionId,
            issue: { id: issueId, identifier: issueIdentifier, title: "Conformance test" },
            issueId,
          },
          promptContext: text,
        });
      }
      return webhook({
        action: "prompted",
        agentSession: { id: sessionId },
        agentActivity: {
          content: { body: text, type: "prompt" },
          id: `prompt-${delivery}`,
          user: { id: user },
          userId: user,
        },
      });
    },
    findOptions(call, prompt) {
      if (call.method !== "AgentActivityCreate") return undefined;
      const input = (call.body as { readonly variables?: { readonly input?: LinearActivityInput } })
        .variables?.input;
      if (input?.content?.type !== "elicitation" || input.content.body.includes(prompt) === false) {
        return undefined;
      }
      return parseVisibleOptions(input.content.body);
    },
    press: () => {
      throw new Error("Linear native select pressing is not supported by this conformance driver.");
    },
    postedText(call) {
      if (call.method !== "AgentActivityCreate") return undefined;
      const input = (call.body as { readonly variables?: { readonly input?: LinearActivityInput } })
        .variables?.input;
      return input?.content?.type === "response" ? input.content.body : undefined;
    },
    shownMessage(call) {
      if (call.method !== "AgentActivityCreate") return undefined;
      const input = (call.body as { readonly variables?: { readonly input?: LinearActivityInput } })
        .variables?.input;
      if (input?.content === undefined) return undefined;
      const response = call.response as {
        readonly data: {
          readonly agentActivityCreate: { readonly agentActivity: { readonly id: string } };
        };
      };
      return {
        id: response.data.agentActivityCreate.agentActivity.id,
        // An `auth` elicitation's sign-in link rides in its signal metadata.
        links: linkTargets(input.signalMetadata),
        // The driver can't press Linear's native select, so nothing here is pressable.
        options: [],
        text: input.content.body,
      };
    },
  };
}

interface LinearActivityInput {
  readonly content?: { readonly body: string; readonly type: string };
  readonly signalMetadata?: unknown;
}

function parseVisibleOptions(body: string): RenderedOption[] {
  return [...body.matchAll(/^\s*(\d+)\.\s+(.+)\s*$/gmu)].map((match) => ({
    handle: match[1],
    label: match[2]!.trim().split(" - ", 1)[0]!.trim(),
  }));
}
