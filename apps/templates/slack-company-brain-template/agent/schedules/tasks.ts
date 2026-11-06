import { callSlackApi } from "eve/channels/slack";
import { defineDynamicSchedules } from "eve/experimental/schedules";
import { z } from "zod";
import slack from "../channels/slack.ts";
import { isHomeTeam, slackCredentials, slackTeamId } from "../lib/slack.ts";

interface TaskPayload {
  readonly task: string;
  readonly teamId: string;
  readonly userId: string;
  readonly channelId: string;
  /** Set when results go back to the thread the schedule was created in. */
  readonly threadTs?: string;
}

function attribute(attributes: Readonly<Record<string, unknown>>, key: string) {
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// A deactivated or external account stops its schedules from running.
async function isActiveMember(payload: TaskPayload): Promise<boolean> {
  const response = (await callSlackApi({
    botToken: slackCredentials.botToken,
    context: { teamId: payload.teamId },
    operation: "users.info",
    body: { user: payload.userId },
  })) as { ok: boolean; error?: string; user?: { deleted?: boolean; team_id?: string } };
  if (!response.ok) {
    if (response.error === "user_not_found") return false;
    // Anything else may be transient; throwing lets the provider retry.
    throw new Error(`Slack users.info failed: ${response.error ?? "unknown error"}`);
  }
  return response.user?.deleted !== true && isHomeTeam(response.user?.team_id);
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
    return {
      task: input.task,
      teamId,
      userId,
      channelId,
      ...(input.reply === "this_thread" && threadTs ? { threadTs } : {}),
    };
  },
  async auth({ principal, payload }) {
    if (principal.type !== "user" || principal.authenticator !== "slack-webhook") return null;
    if (principal.principalId !== `slack:${payload.teamId}:${payload.userId}`) return null;
    if (!(await isActiveMember(payload))) return null;
    return {
      attributes: {
        author_type: "user",
        channel_id: payload.channelId,
        team_id: payload.teamId,
        user_id: payload.userId,
      },
      authenticator: principal.authenticator,
      ...(principal.issuer === undefined ? {} : { issuer: principal.issuer }),
      principalId: principal.principalId,
      principalType: "user",
      ...(principal.subject === undefined ? {} : { subject: principal.subject }),
    };
  },
  async run({ payload, occurrence, to }) {
    const target = {
      channelId: payload.channelId,
      installationTeamId: payload.teamId,
      ...(payload.threadTs === undefined ? {} : { threadTs: payload.threadTs }),
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
