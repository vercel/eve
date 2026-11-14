import { defineDynamicSchedules } from "eve/experimental/schedules";
import { z } from "zod";
import slack from "../channels/slack.ts";
import { callSlack, isFullMember, slackTeamId } from "../lib/slack.ts";

interface TaskPayload {
  task: string;
  teamId: string;
  userId: string;
  channelId: string;
  /** Set when results go back to the thread the schedule was created in. */
  threadTs?: string;
}

function attribute(attributes: Readonly<Record<string, unknown>>, key: string) {
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const MEMBER_PAGES = 10;

// Whether the creator can still see the schedule's conversation. A full member
// can read and join any public channel, and a DM with the app is always theirs,
// so only private channels and group DMs need a membership check. Without it,
// someone removed from a private channel would keep posting there through the
// bot. Errors other than a missing channel throw so the provider retries.
async function canReachChannel(payload: TaskPayload): Promise<boolean> {
  const info = await callSlack<{
    channel: { is_private?: boolean; is_im?: boolean; is_mpim?: boolean };
  }>(payload.teamId, "conversations.info", { channel: payload.channelId });
  if (!info.ok) {
    if (info.error === "channel_not_found") return false;
    throw new Error(`Slack conversations.info failed: ${info.error ?? "unknown error"}`);
  }
  const channel = info.channel;
  if (!channel) return false;
  if (channel.is_im || (!channel.is_private && !channel.is_mpim)) return true;

  let cursor: string | undefined;
  for (let page = 0; page < MEMBER_PAGES; page++) {
    const response = await callSlack<{
      members: string[];
      response_metadata: { next_cursor?: string };
    }>(payload.teamId, "conversations.members", {
      channel: payload.channelId,
      limit: 1000,
      cursor,
    });
    if (!response.ok) {
      if (response.error === "channel_not_found") return false;
      throw new Error(`Slack conversations.members failed: ${response.error ?? "unknown error"}`);
    }
    if (response.members?.includes(payload.userId)) return true;
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) return false;
  }
  // Too large to check: fail closed.
  return false;
}

// People ask in Slack ("every Monday at 9, post open questions from #support
// here"), and the model calls the generated `schedule__tasks__*` tools. Each
// run starts a new session in the Slack conversation the schedule was created
// in, running as its creator.
export default defineDynamicSchedules({
  description:
    "Scheduled tasks and reminders that run later and post in the Slack conversation where they were created. " +
    "Use the person's local time zone for single and cron timing, and ask for it when you don't know it. " +
    "Write the task as a complete request to your future self: no one will be present to answer questions or approve actions when it runs.",
  inputSchema: z
    .object({
      task: z.string().min(1).max(4000).describe("What to do each time the schedule runs."),
      reply: z
        .enum(["new_thread", "this_thread"])
        .default("new_thread")
        .describe(
          "Post each run as a new thread in this conversation, or reply in the current thread.",
        ),
    })
    .strict(),
  // The destination and creator come from the trusted Slack session, never
  // from the model, so a schedule can only post where its creator asked for it.
  preparePayload(input, { session }): TaskPayload {
    if (session.schedule) throw new Error("Scheduled runs can't create or replace schedules.");
    const auth = session.auth.current;
    if (auth?.authenticator !== "slack-webhook" || auth.principalType !== "user") {
      throw new Error("Schedules can only be created from a Slack message.");
    }
    const teamId = slackTeamId(auth);
    const userId = attribute(auth.attributes, "user_id");
    const channelId = attribute(auth.attributes, "channel_id");
    const threadTs = attribute(auth.attributes, "thread_ts");
    if (!teamId || !userId || !channelId) {
      throw new Error("This Slack message is missing the workspace, user, or channel.");
    }
    const payload: TaskPayload = {
      task: input.task,
      teamId,
      userId,
      channelId,
    };
    if (input.reply === "this_thread" && threadTs) payload.threadTs = threadTs;
    return payload;
  },
  async auth({ principal, payload }) {
    if (principal.type !== "user" || principal.authenticator !== "slack-webhook") return null;
    if (principal.principalId !== `slack:${payload.teamId}:${payload.userId}`) return null;
    // A member who is deactivated, leaves, becomes a guest, or loses access to
    // the conversation stops their schedules: returning null fails each
    // occurrence without a retry. A failed lookup throws so the provider retries.
    if (!(await isFullMember(payload.teamId, payload.userId))) return null;
    if (!(await canReachChannel(payload))) return null;
    const { type: _type, ...identity } = principal;
    return {
      ...identity,
      attributes: {
        author_type: "user",
        channel_id: payload.channelId,
        team_id: payload.teamId,
        user_id: payload.userId,
      },
      principalType: "user",
    };
  },
  async run({ payload, occurrence, to }) {
    const target = {
      channelId: payload.channelId,
      installationTeamId: payload.teamId,
      threadTs: payload.threadTs,
    };
    await to(slack, target).send(
      [
        `Run this scheduled task for <@${payload.userId}> now and post the result.`,
        "No one is present to answer questions or approve actions. If you can't finish, say what's missing.",
        `Schedule: ${occurrence.displayName ?? occurrence.name}`,
        `Scheduled for: ${occurrence.scheduledAt}`,
        `Task: ${payload.task}`,
      ].join("\n"),
      // Provider retries reuse the key, so a retried run reaches the same thread.
      { idempotencyKey: `${occurrence.executionId}:run` },
    );
  },
});
