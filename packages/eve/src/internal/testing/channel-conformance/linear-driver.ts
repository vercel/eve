import {
  type ChannelDriver,
  type PlatformCall,
  type RenderedOption,
  recordingFetch,
} from "#internal/testing/channel-conformance/harness.js";
import { linearChannel } from "#public/channels/linear/index.js";
import { signLinearWebhookBody } from "#public/channels/linear/verify.js";

const SECRET = "linear-conformance-secret";
let nextConversation = 0;

/** Drives Linear Agent Session webhooks and Agent Activity GraphQL mutations. */
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

  async function decode(request: Request): Promise<PlatformCall> {
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
    capabilities: ["text-replies"],
    // An agent session lives on an issue the whole workspace can see.
    surface: "shared",
    createChannel: (record) =>
      linearChannel({
        api: { fetch: recordingFetch(record, decode) },
        credentials: { accessToken: "linear-token", webhookSecret: SECRET },
      }),
    message: (text) => {
      if (delivery === 0) {
        return webhook({
          action: "created",
          agentSession: {
            creator: { id: "user_1" },
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
          user: { id: "user_1" },
          userId: "user_1",
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
  };
}

interface LinearActivityInput {
  readonly content?: { readonly body: string; readonly type: string };
}

function parseVisibleOptions(body: string): RenderedOption[] {
  return [...body.matchAll(/^\s*(\d+)\.\s+(.+)\s*$/gmu)].map((match) => ({
    handle: match[1],
    label: match[2]!.trim().split(" - ", 1)[0]!.trim(),
  }));
}
