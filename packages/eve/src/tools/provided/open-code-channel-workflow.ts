import { transcriptReducer } from "#client/index.js";
import { sessions } from "#public/server/index.js";
import type { SlackChannel } from "#public/channels/slack/index.js";
import type { WorkflowToolContext } from "#public/tools/index.js";
import type {
  OpenCodeChannelInput,
  OpenCodeChannelOutput,
} from "#tools/provided/open-code-channel.js";

/**
 * Forks the calling Slack conversation into a new code channel, through the
 * Slack channel that serves this session.
 */
export async function executeOpenCodeChannel(
  input: OpenCodeChannelInput,
  ctx: WorkflowToolContext,
): Promise<OpenCodeChannelOutput> {
  "use workflow";

  // The Slack channel's metadata names the conversation and the message that
  // triggered the turn, whatever auth the session runs as.
  const { metadata = {}, name } = ctx.channel;
  const { channelId, codeChannel, installationTeamId, threadTs, triggeringMessageTs } = metadata;
  // Slack doesn't open a code channel from inside one.
  if (codeChannel === true) return unavailable("This conversation is already a code channel.");
  if (name === undefined || typeof channelId !== "string" || typeof threadTs !== "string") {
    return unavailable("This conversation is not a Slack message.");
  }

  const history = await readSessionTranscript(ctx.session.id);
  // Slack refusals fail the call with Slack's error, which the model can relay.
  const { sessionId } = await ctx.sendToChannel<SlackChannel>(name, input.message, {
    target: {
      channelId,
      // Slack checks this session is the origin thread's before creating anything.
      codeChannel: {
        name: input.name,
        originThreadTs: threadTs,
        originTs: typeof triggeringMessageTs === "string" ? triggeringMessageTs : threadTs,
      },
      ...(typeof installationTeamId === "string" && { installationTeamId }),
    },
    auth: ctx.session.auth.current,
    history,
  });
  return { sessionId, status: "opened" };
}

function unavailable(reason: string): OpenCodeChannelOutput {
  return { reason, status: "unavailable" };
}

async function readSessionTranscript(sessionId: string) {
  "use step";
  const reducer = transcriptReducer();
  let transcript = reducer.initial();
  for await (const event of sessions.attach(sessionId).stream({ follow: false })) {
    transcript = reducer.reduce(transcript, event);
  }
  return transcript.messages;
}
