import { z } from "#compiled/zod/index.js";
import { contextStorage } from "#context/container.js";
import { ScheduleOriginKey } from "#context/keys.js";
import {
  captureSlackActionContext,
  matchesSlackActionRequester,
} from "#public/experimental/slack/action-context.js";
import { callSlackApiTrackingResponse } from "#public/channels/slack/api-errors.js";
import { resolveSlackBotToken, type SlackBotToken } from "#public/channels/slack/api.js";
import { defineTool, type ToolContext } from "#tools/definition.js";

export interface SlackSendMessageOptions {
  /** Share this resolver with slackChannel credentials; resolved at execution, never persisted. */
  readonly botToken: SlackBotToken;
  /** Additional app-authorized channels, keyed by receiving installation workspace. */
  readonly channelIds?: Readonly<Record<string, readonly string[]>>;
}

const channelIdSchema = z.string().regex(/^[CDG][A-Z0-9]+$/u);
const threadSchema = z.string().regex(/^\d{10,16}\.\d{6}$/u);
const inputSchema = z
  .object({
    target: z
      .string()
      .max(128)
      .describe(
        'Slack destination: "requester" for the requesting person’s DM, "origin" for the conversation they asked in, "user:U…" for their explicit user ID, or "channel:C…" for an authorized channel. This tool sends content directly; it does not start another agent.',
      ),
    message: z.string().trim().min(1).max(4000),
    threadTs: threadSchema
      .optional()
      .describe(
        "Optional thread for an explicitly authorized channel; ignored for requester and origin targets.",
      ),
  })
  .strict();

type SendInput = z.infer<typeof inputSchema>;
export interface SlackSendMessageReceipt {
  readonly delivered: true;
  readonly channelId: string;
  readonly messageId: string;
}

/** Optional direct Slack action for ordinary and scheduled agent turns. */
export function slackSendMessage(options: SlackSendMessageOptions) {
  return defineTool({
    description:
      "Send a Slack message now to the requester, origin conversation, or an app-authorized channel. Use this for an explicit message or DM request, including a scheduled request. A successful result confirms delivery; do not repeat the delivered content in your final answer. No email or other platform delivery is available through this tool.",
    inputSchema,
    async execute(input, context): Promise<SlackSendMessageReceipt> {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) throw new Error("Invalid Slack message input.");
      const destination = resolveDestination(options, parsed.data, context);
      const signal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(30_000)]);
      const request = async (operation: string, body: Record<string, unknown>) => {
        signal.throwIfAborted();
        try {
          return await callSlackApiTrackingResponse(operation, body, {
            token: async () => {
              const token = await resolveSlackBotToken(options.botToken, {
                teamId: destination.installationTeamId,
              });
              signal.throwIfAborted();
              return token;
            },
            fetch: (url: string | URL | Request, init?: RequestInit) =>
              fetch(url, { ...init, signal, redirect: "error" }),
          });
        } catch {
          throw new Error(
            "Slack delivery could not be confirmed. Do not retry automatically; check the destination before sending again.",
          );
        }
      };
      let channelId = destination.channelId;
      if (destination.userId !== undefined) {
        const opened = await request("conversations.open", { users: destination.userId });
        const channel = opened.channel as { id?: unknown } | undefined;
        if (
          opened.ok !== true ||
          typeof channel?.id !== "string" ||
          !/^D[A-Z0-9]+$/u.test(channel.id)
        ) {
          throw new Error(
            "Slack could not open the requester's DM. Check the app installation and im:write permission.",
          );
        }
        channelId = channel.id;
      }
      const posted = await request("chat.postMessage", {
        channel: channelId,
        thread_ts: destination.threadTs,
        text: parsed.data.message,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (posted.ok !== true) {
        throw new Error(
          "Slack rejected the message. Check destination access and chat:write permission.",
        );
      }
      if (posted.channel !== channelId || !threadSchema.safeParse(posted.ts).success) {
        throw new Error(
          "Slack returned no matching delivery receipt. Do not retry automatically; check the destination first.",
        );
      }
      return { delivered: true, channelId: channelId!, messageId: posted.ts as string };
    },
  });
}

function resolveDestination(
  options: SlackSendMessageOptions,
  input: SendInput,
  context: ToolContext,
): {
  installationTeamId: string;
  channelId?: string;
  userId?: string;
  threadTs?: string;
} {
  const origin = contextStorage.getStore()?.get(ScheduleOriginKey);
  // A captured creator identifies the recipient even when execution uses app auth.
  const requester = origin === undefined ? context.session.auth.current : origin.auth.current;
  if (requester?.authenticator !== "slack-webhook" || requester.principalType !== "user") {
    throw new Error("This Slack tool requires a verified requester.");
  }
  const slack = origin === undefined ? captureSlackActionContext(requester) : origin.slack;
  if (slack === undefined || !matchesSlackActionRequester(slack, requester)) {
    throw new Error(
      "Trusted Slack installation context is missing or inconsistent. Retry from Slack or recreate the schedule from Slack.",
    );
  }
  const { installationTeamId, userId, channelId: originChannel, threadTs: originThread } = slack;
  if (input.target === "requester" || input.target === `user:${userId}`) {
    return { installationTeamId, userId };
  }
  if (input.target === "origin") {
    if (
      !channelIdSchema.safeParse(originChannel).success ||
      !threadSchema.safeParse(originThread).success
    ) {
      throw new Error("The Slack origin conversation is unavailable; no message was sent.");
    }
    return { installationTeamId, channelId: originChannel, threadTs: originThread };
  }
  const channelId = input.target.startsWith("channel:") ? input.target.slice(8) : "";
  if (!channelIdSchema.safeParse(channelId).success) {
    throw new Error(
      "Unsupported Slack target. Use requester, origin, or an authorized channel ID.",
    );
  }
  if (options.channelIds?.[installationTeamId]?.includes(channelId)) {
    return { installationTeamId, channelId };
  }
  if (channelId === originChannel && threadSchema.safeParse(originThread).success) {
    return { installationTeamId, channelId, threadTs: originThread };
  }
  throw new Error("This Slack destination is not authorized by the tool's policy.");
}
