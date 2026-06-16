import type { SessionAuthContext } from "#channel/types.js";

import { extractErrorId, formatErrorHint } from "#internal/logging.js";
import { createLinearAgentActivity, type LinearApiOptions } from "#public/channels/linear/api.js";
import type { LinearChannelCredentials } from "#public/channels/linear/auth.js";
import { renderLinearInputRequests } from "#public/channels/linear/hitl.js";
import type { LinearAgentSessionEvent, LinearUser } from "#public/channels/linear/inbound.js";
import type {
  LinearChannelEvents,
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
export interface LinearDefaultEventOptions {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
}

/** Built-in Linear event handlers for Agent Activity progress, replies, HITL, and errors. */
export function createDefaultEvents(options: LinearDefaultEventOptions = {}): LinearChannelEvents {
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

    async "actions.requested"(event, channel, _ctx) {
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

      if (event.actions.length === 0) return;
      if (event.actions.length > 1) {
        await postActivity(
          channel,
          options,
          {
            action: "Running",
            parameter: event.actions.map(actionLabel).join(", "),
            type: "action",
          },
          {
            ephemeral: true,
          },
        );
        return;
      }

      for (const action of event.actions) {
        await postActivity(
          channel,
          options,
          {
            action: actionLabel(action),
            parameter: actionParameter(action),
            type: "action",
          },
          {
            ephemeral: true,
          },
        );
      }
    },

    async "input.requested"(event, channel, _ctx) {
      await postActivity(channel, options, {
        body: renderLinearInputRequests(event.requests),
        type: "elicitation",
      });
    },

    async "message.completed"(event, channel, _ctx) {
      if (event.finishReason === "tool-calls") {
        channel.state.pendingToolCallMessage = event.message
          ? (firstNonEmptyLine(event.message) ?? null)
          : null;
        return;
      }
      channel.state.pendingToolCallMessage = null;
      if (!event.message) return;
      await postActivity(channel, options, {
        body: event.message,
        type: "response",
      });
    },

    async "session.failed"(event, channel) {
      const hint = formatErrorHint(event);
      const errorId = extractErrorId(event.details);
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

    async "turn.failed"(event, channel, _ctx) {
      const hint = formatErrorHint(event);
      const errorId = extractErrorId(event.details);
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
  } = {},
): Promise<{ readonly id: string; readonly success: boolean }> {
  return createLinearAgentActivity({
    api: options.api,
    credentials: options.credentials,
    activity: {
      agentSessionId: requireAgentSessionId(channel.state.agentSessionId),
      content,
      ephemeral: activityOptions.ephemeral,
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

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function actionLabel(action: { readonly kind: string; readonly toolName?: string }): string {
  return action.kind === "tool-call" && action.toolName ? action.toolName : action.kind;
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
