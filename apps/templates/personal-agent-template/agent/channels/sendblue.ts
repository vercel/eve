import type { ChannelFrom, ChannelSendOptions, ChannelSource } from "eve/channels";
import { defineChannel, POST } from "eve/channels";
import type { SendblueMessagePayload } from "chat-adapter-sendblue";
import { agent } from "../../shared/agent.js";
import { buildAppSessionAuth } from "../../shared/slack-auth.js";
import { fetchPhoneLinkForNumber } from "../lib/phone-internal.js";
import {
  contactNumberFromPayload,
  getSendblueAdapter,
  isInboundSendblueMessage,
  isSendblueConfigured,
  isSendblueServiceAllowed,
  profileSettingsUrl,
  resolveSendblueLineNumber,
  threadIdFromPayload,
  verifySendblueWebhook,
} from "../lib/sendblue.js";

const WEBHOOK_ROUTE = "/eve/v1/sendblue/webhook";

const IMESSAGE_CHANNEL_CONTEXT = [
  "Channel: iMessage (Sendblue). There is no browser UI in this thread.",
  "Answer the user's question directly with tools when needed.",
  "Do not call save_memory unless they explicitly ask you to remember or save something.",
] as const;

interface PendingInputRequest {
  requestId: string;
  toolName: string;
}

interface SendblueChannelState {
  threadId: string | null;
  contactNumber: string | null;
  fromNumber: string | null;
  groupId: string | null;
  isGroup: boolean;
  pendingToolCallMessage: string | null;
}

interface SendblueChannelContext {
  sendblue: ReturnType<typeof getSendblueAdapter>;
  state: SendblueChannelState;
}

function firstNonEmptyLine(text: string) {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

async function postToThread(threadId: string, message: string) {
  try {
    const sendblue = getSendblueAdapter();
    await sendblue.postMessage(threadId, { markdown: message });
  } catch (error) {
    console.error("[sendblue] outbound delivery failed", error);
  }
}

function threadIdForState(
  sendblue: ReturnType<typeof getSendblueAdapter>,
  state: Pick<SendblueChannelState, "threadId" | "fromNumber" | "contactNumber">,
) {
  if (state.fromNumber && state.contactNumber) {
    return sendblue.encodeThreadId({
      fromNumber: state.fromNumber,
      contactNumber: state.contactNumber,
    });
  }

  return state.threadId;
}

const pendingInputByThread = new Map<string, PendingInputRequest[]>();

interface InflightSend {
  source: ChannelSource<SendblueChannelState>;
  auth: ChannelSendOptions<SendblueChannelState>["auth"];
}

let inflightSend: InflightSend | null = null;

function parseApprovalReply(text: string): "approve" | "deny" | null {
  const normalized = text.trim().toLowerCase();
  if (/^(yes|y|oui|ok|approve|remember)$/u.test(normalized)) {
    return "approve";
  }
  if (/^(no|n|non|skip|deny)$/u.test(normalized)) {
    return "deny";
  }
  return null;
}

function isSaveMemoryRequest(request: PendingInputRequest) {
  return request.toolName === "save_memory";
}

function denyResponses(requests: readonly PendingInputRequest[]) {
  return requests.map((request) => ({
    requestId: request.requestId,
    optionId: "deny" as const,
  }));
}

async function resolvePendingInput(
  threadId: string,
  text: string,
  source: ChannelSource<SendblueChannelState>,
  sendOptions: ChannelSendOptions<SendblueChannelState>,
) {
  const pending = pendingInputByThread.get(threadId);
  if (!pending?.length) {
    return false;
  }

  const onlySaveMemory = pending.every(isSaveMemoryRequest);
  const approval = onlySaveMemory ? "deny" : parseApprovalReply(text);

  if (!approval) {
    await postToThread(
      threadId,
      onlySaveMemory
        ? `Skipping memory save — edit your profile at ${profileSettingsUrl()}.`
        : "Reply YES to approve or NO to skip the pending action.",
    );
    return true;
  }

  pendingInputByThread.delete(threadId);

  try {
    inflightSend = {
      source,
      auth: sendOptions.auth,
    };
    await source.respond(
      pending.map((request) => ({
        requestId: request.requestId,
        optionId: approval,
      })),
      { auth: sendOptions.auth },
    );
  } finally {
    inflightSend = null;
  }

  if (onlySaveMemory) {
    await postToThread(
      threadId,
      `Memory saves are not available in iMessage. Edit your profile at ${profileSettingsUrl()}.`,
    );
    return false;
  }

  return true;
}

async function dispatchInbound(
  payload: SendblueMessagePayload,
  from: ChannelFrom<SendblueChannelState>,
) {
  const sendblue = getSendblueAdapter();
  const threadId = threadIdFromPayload(payload, sendblue);
  const contactNumber = contactNumberFromPayload(payload);
  const text = payload.content?.trim() ?? "";

  if (!text) {
    return;
  }

  const link = await fetchPhoneLinkForNumber(contactNumber);
  if (!link) {
    await postToThread(
      threadId,
      [
        `Your phone number is not linked to ${agent.name} yet.`,
        "",
        `Add it in ${profileSettingsUrl()} using E.164 format (for example +33612345678), then message again.`,
      ].join("\n"),
    );
    return;
  }

  const auth = buildAppSessionAuth(link.appUserId, {
    channel: "sendblue",
    phone_number: contactNumber,
  });

  const fromNumber = resolveSendblueLineNumber(payload);

  const sendOptions = {
    auth,
    state: {
      threadId,
      contactNumber,
      fromNumber,
      groupId: payload.group_id?.length ? payload.group_id : null,
      isGroup: Boolean(payload.group_id?.length),
      pendingToolCallMessage: null,
    } satisfies SendblueChannelState,
  } satisfies ChannelSendOptions<SendblueChannelState>;

  const source = from(threadId);

  try {
    const blocked = await resolvePendingInput(threadId, text, source, sendOptions);
    if (blocked) {
      return;
    }

    inflightSend = { source, auth };
    await source.send(text, {
      ...sendOptions,
      context: [...IMESSAGE_CHANNEL_CONTEXT],
    });
  } catch (error) {
    console.error("[sendblue] agent send failed", error);
  } finally {
    inflightSend = null;
  }
}

export default defineChannel<SendblueChannelState, SendblueChannelContext>({
  kindHint: "sendblue",

  state: {
    threadId: null,
    contactNumber: null,
    fromNumber: null,
    groupId: null,
    isGroup: false,
    pendingToolCallMessage: null,
  },

  metadata(state) {
    return {
      contactNumber: state.contactNumber,
      fromNumber: state.fromNumber,
      isGroup: state.isGroup,
      threadId: state.threadId,
    };
  },

  context(state) {
    return {
      sendblue: getSendblueAdapter(),
      state,
    };
  },

  routes: [
    POST(WEBHOOK_ROUTE, async (request, { from, waitUntil }) => {
      if (!isSendblueConfigured()) {
        return new Response("Sendblue is not configured", { status: 503 });
      }

      if (!verifySendblueWebhook(request)) {
        return new Response("Unauthorized", { status: 401 });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      if (body && typeof body === "object" && "is_typing" in body) {
        return new Response("OK", { status: 200 });
      }

      if (!isInboundSendblueMessage(body)) {
        return new Response("OK", { status: 200 });
      }

      const payload = body;

      if (!isSendblueServiceAllowed(payload.service)) {
        return new Response("OK", { status: 200 });
      }

      if (payload.is_outbound || payload.status !== "RECEIVED") {
        return new Response("OK", { status: 200 });
      }

      if (payload.group_id?.length) {
        const sendblue = getSendblueAdapter();
        const threadId = threadIdFromPayload(payload, sendblue);
        waitUntil(
          postToThread(
            threadId,
            `Group chats are not supported yet. Message ${agent.name} in a direct conversation instead.`,
          ),
        );
        return new Response("OK", { status: 200 });
      }

      waitUntil(dispatchInbound(payload, from));
      return new Response("OK", { status: 200 });
    }),
  ],

  events: {
    async "turn.started"(_event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId || channel.state.isGroup) {
        return;
      }

      await channel.sendblue.startTyping(threadId).catch(() => undefined);
    },

    async "actions.requested"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId || channel.state.isGroup) {
        return;
      }

      const pending = channel.state.pendingToolCallMessage;
      channel.state.pendingToolCallMessage = null;

      if (pending) {
        await postToThread(threadId, pending);
        return;
      }

      await channel.sendblue.startTyping(threadId).catch(() => undefined);
      void event;
    },

    async "message.completed"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId) {
        return;
      }

      if (event.finishReason === "tool-calls") {
        const pending = event.message ? (firstNonEmptyLine(event.message) ?? null) : null;
        channel.state.pendingToolCallMessage = pending;

        if (pending) {
          await postToThread(threadId, pending);
        } else {
          await postToThread(threadId, "Working on that — I'll reply in a moment.");
        }
        return;
      }

      channel.state.pendingToolCallMessage = null;

      if (!event.message) {
        return;
      }

      await postToThread(threadId, event.message);
    },

    async "input.requested"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId || event.requests.length === 0) {
        return;
      }

      const pending = event.requests.map((request) => ({
        requestId: request.requestId,
        toolName: request.action.toolName,
      }));
      const onlySaveMemory = pending.every(isSaveMemoryRequest);

      if (onlySaveMemory && inflightSend) {
        await postToThread(
          threadId,
          `Memory saves need the web profile on iMessage — skipping. Edit at ${profileSettingsUrl()}.`,
        );
        try {
          await inflightSend.source.respond(denyResponses(pending), {
            auth: inflightSend.auth,
          });
        } catch (error) {
          console.error("[sendblue] save_memory auto-deny failed", error);
        }
        return;
      }

      pendingInputByThread.set(threadId, pending);

      if (onlySaveMemory) {
        await postToThread(
          threadId,
          `Memory saves are not available in iMessage. Edit your profile at ${profileSettingsUrl()}.`,
        );
        return;
      }

      const prompts = event.requests.map((request) => request.prompt).join("\n\n");
      await postToThread(threadId, [prompts, "", "Reply YES to approve or NO to skip."].join("\n"));
    },

    async "authorization.required"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId) {
        return;
      }

      const url = event.authorization?.url;
      const userCode = event.authorization?.userCode;
      const lines = url
        ? [
            `Sign in to ${event.name} to continue: ${url}`,
            ...(userCode ? [`Code: ${userCode}`] : []),
          ]
        : [
            `Authorization is required for ${event.name}.`,
            `Open ${profileSettingsUrl()} to connect integrations, then try again.`,
          ];

      await postToThread(threadId, lines.join("\n"));
    },

    async "turn.failed"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId) {
        return;
      }

      await postToThread(
        threadId,
        [
          "I hit an error while handling your request.",
          "",
          "Please try again, rephrase, or open the web chat if it keeps failing.",
        ].join("\n"),
      );

      void event;
    },

    async "session.failed"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId) {
        return;
      }

      await postToThread(
        threadId,
        [
          "This session could not recover from an error.",
          "",
          "Send a new message to start again.",
        ].join("\n"),
      );

      void event;
    },
  },
});
