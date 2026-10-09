import { errorHintOf } from "#public/channels/reply.js";
import { contentPhase } from "#protocol/session-events/catalog.js";
import { promptQueueEvents } from "#channel/prompt-queue.js";
import { signInPromptOf, signInSettlementOf } from "#channel/interaction-prompts.js";
import type { SessionAuthContext } from "#channel/types.js";

import { formatErrorHint } from "#internal/logging.js";
import { createLinearAgentActivity, type LinearApiOptions } from "#public/channels/linear/api.js";
import type { LinearChannelCredentials } from "#public/channels/linear/auth.js";
import {
  linearInputRequestSignal,
  renderLinearInputRequests,
} from "#public/channels/linear/hitl.js";
import type { LinearAgentSessionEvent, LinearUser } from "#public/channels/linear/inbound.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import { isTaskControlTool } from "#protocol/task-tools.js";
import { displayTitle } from "#shared/display-name.js";
import type { InputRequest } from "#shared/input.js";
import type {
  LinearChannelEvents,
  LinearEventContext,
  LinearInboundResult,
  LinearSessionContext,
} from "#public/channels/linear/linearChannel.js";

/** Default Linear auth projection for Agent Session webhook actors. */
export function defaultLinearAuth(event: LinearAgentSessionEvent): SessionAuthContext {
  const user = event.agentActivity?.user ?? event.agentSession.creator;
  const userId =
    event.agentActivity?.userId ?? event.agentSession.creatorId ?? user?.id ?? "unknown";
  const attributes: Record<string, string> = {
    action: event.action,
    agent_session_id: event.agentSession.id,
    organization_id: event.organizationId ?? event.agentSession.organizationId ?? "",
  };
  if (event.delivery.id !== undefined) attributes.delivery_id = event.delivery.id;
  if (event.agentSession.issueId !== undefined && event.agentSession.issueId !== null) {
    attributes.issue_id = event.agentSession.issueId;
  }
  if (event.agentSession.issue?.identifier !== undefined) {
    attributes.issue_identifier = event.agentSession.issue.identifier;
  }
  if (user !== undefined) {
    const label = linearUserLabel(user);
    if (label !== undefined) attributes.user = label;
  }

  return {
    attributes,
    authenticator: "linear-agent-webhook",
    issuer: event.organizationId ? `linear:${event.organizationId}` : "linear",
    principalId: `linear:${userId}`,
    principalType: "user",
    subject: userId,
  };
}

/** Default Agent Session hook: dispatch created/prompted events with Linear user auth. */
export function defaultOnAgentSession(
  _ctx: LinearSessionContext,
  event: LinearAgentSessionEvent,
): LinearInboundResult {
  if (event.action !== "created" && event.action !== "prompted") return null;
  return { auth: defaultLinearAuth(event) };
}

/** Options used by built-in Linear event handlers. */
interface LinearDefaultEventOptions {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
}

/** Built-in Linear event handlers for Agent Activity progress, replies, HITL, and errors. */
export function createDefaultEvents(options: LinearDefaultEventOptions = {}): LinearChannelEvents {
  async function showPrompt(channel: LinearEventContext, request: InputRequest): Promise<void> {
    await postActivity(
      channel,
      options,
      { body: renderLinearInputRequests([request]), type: "elicitation" },
      linearInputRequestSignal([request]),
    );
  }

  // A reply can only answer the elicitation it sees, so they post one at a time.
  const prompts = promptQueueEvents(showPrompt);

  return {
    async "turn.started"(_event, channel, _ctx) {
      channel.state.pendingToolCallMessage = null;
      await postActivity(
        channel,
        options,
        {
          body: "Working on this.",
          type: "thought",
        },
        {
          ephemeral: true,
        },
      );
    },

    async "call.requested"(event, channel, _ctx) {
      const buffered = channel.state.pendingToolCallMessage;
      channel.state.pendingToolCallMessage = null;
      if (buffered) {
        await postActivity(
          channel,
          options,
          {
            body: buffered,
            type: "thought",
          },
          {
            ephemeral: true,
          },
        );
        return;
      }
      // eve's own task controls stay out of view.
      if (isTaskControlTool(event.capability.name)) return;
      await postActivity(
        channel,
        options,
        {
          action: event.capability.title ?? displayTitle(event.capability.name),
          parameter: actionParameter({ input: event.input }),
          type: "action",
        },
        {
          ephemeral: true,
        },
      );
    },

    async "interaction.opened"(data, channel, ctx) {
      await prompts["interaction.opened"](data, channel, ctx);
      const event = signInPromptOf(data, ctx.scope);
      if (event === undefined) return;
      const displayName = authorizationDisplayName(event.name, event.authorization?.displayName);
      const url = event.authorization?.url;
      const userId = linearUserId(ctx);
      let authSignal: Parameters<typeof postActivity>[3];
      if (url !== undefined) {
        const signalMetadata: Record<string, string> = { providerName: displayName, url };
        if (userId !== undefined) signalMetadata.userId = userId;
        authSignal = { signal: "auth", signalMetadata };
      }
      await postActivity(
        channel,
        options,
        {
          body: authorizationRequiredBody({
            displayName,
            instructions: event.authorization?.instructions,
            userCode: event.authorization?.userCode,
          }),
          type: "elicitation",
        },
        authSignal,
      );
    },

    async "interaction.settled"(data, channel, ctx) {
      await prompts["interaction.settled"](data, channel, ctx);
      const event = signInSettlementOf(ctx.view, data);
      if (event === undefined) return;
      const displayName = authorizationDisplayName(event.name, event.authorization?.displayName);
      if (event.outcome === "authorized") {
        await postActivity(
          channel,
          options,
          {
            body: `Connected to ${displayName}. Resuming.`,
            type: "thought",
          },
          { ephemeral: true },
        );
        return;
      }

      const reason = event.reason === undefined ? "" : ` (${event.reason})`;
      await postActivity(channel, options, {
        body: `${displayName} authorization ${formatAuthorizationOutcome(event.outcome)}${reason}.`,
        type: "thought",
      });
    },

    async "content.completed"(event, channel, _ctx) {
      if (event.kind !== "text" || typeof event.value !== "string") return;
      // Narration before calls posts as a thought with the next call.
      if (contentPhase(event.phase) === "narration") {
        channel.state.pendingToolCallMessage = event.value
          ? (firstNonEmptyLine(event.value) ?? null)
          : null;
        return;
      }
      channel.state.pendingToolCallMessage = null;
      if (!event.value) return;
      await postActivity(channel, options, {
        body: event.value,
        type: "response",
      });
    },

    async "session.ended"(event, channel, _ctx) {
      if (event.outcome !== "failed") return;
      const hint = formatErrorHint(errorHintOf(event.error));
      const errorId = event.error?.id;
      await postActivity(channel, options, {
        body: [
          `This session could not recover from an error${hint}.`,
          "",
          "Start a new Linear agent session to continue.",
          ...(errorId ? ["", `Error id: ${errorId}`] : []),
        ].join("\n"),
        type: "error",
      });
    },

    async "turn.settled"(event, channel, _ctx) {
      if (event.outcome !== "failed") return;
      const hint = formatErrorHint(errorHintOf(event.error));
      const errorId = event.error?.id;
      await postActivity(channel, options, {
        body: [
          `I hit an error while handling your request${hint}.`,
          "",
          "Please try again, rephrase, or reach out if it keeps failing.",
          ...(errorId ? ["", `Error id: ${errorId}`] : []),
        ].join("\n"),
        type: "error",
      });
    },
  };
}

function postActivity(
  channel: Parameters<NonNullable<LinearChannelEvents["turn.started"]>>[1],
  options: LinearDefaultEventOptions,
  content: Parameters<typeof createLinearAgentActivity>[0]["activity"]["content"],
  activityOptions: {
    readonly ephemeral?: boolean;
    readonly signal?: Parameters<typeof createLinearAgentActivity>[0]["activity"]["signal"];
    readonly signalMetadata?: Parameters<
      typeof createLinearAgentActivity
    >[0]["activity"]["signalMetadata"];
  } = {},
): Promise<{ readonly id: string; readonly success: boolean }> {
  return createLinearAgentActivity({
    api: options.api,
    credentials: options.credentials,
    activity: {
      agentSessionId: requireAgentSessionId(channel.state.agentSessionId),
      content,
      ephemeral: activityOptions.ephemeral,
      signal: activityOptions.signal,
      signalMetadata: activityOptions.signalMetadata,
    },
  });
}

function requireAgentSessionId(agentSessionId: string | null): string {
  if (agentSessionId === null) {
    throw new Error("linearChannel: cannot post Agent Activity without an Agent Session id.");
  }
  return agentSessionId;
}

function linearUserLabel(user: LinearUser): string | undefined {
  return user.displayName ?? user.name ?? user.email;
}

function authorizationDisplayName(name: string, displayName: string | undefined): string {
  if (displayName !== undefined) return displayName;
  if (name.length === 0) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function authorizationRequiredBody(input: {
  readonly displayName: string;
  readonly instructions?: string;
  readonly userCode?: string;
}): string {
  return [
    `Authorization required for ${input.displayName}.`,
    input.instructions,
    input.userCode === undefined ? undefined : `Code: ${input.userCode}`,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
}

function linearUserId(ctx: SessionContext): string | undefined {
  const auth = ctx.session.auth.current;
  return auth?.authenticator === "linear-agent-webhook" ? auth.subject : undefined;
}

function formatAuthorizationOutcome(outcome: "declined" | "failed" | "timed-out"): string {
  return outcome === "timed-out" ? "timed out" : outcome;
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function actionParameter(action: {
  readonly description?: string;
  readonly input?: unknown;
  readonly name?: string;
}): string {
  if (action.description) return action.description;
  if (action.name) return action.name;
  if (action.input !== undefined) {
    try {
      return JSON.stringify(action.input);
    } catch {
      return "";
    }
  }
  return "";
}
