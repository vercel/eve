/**
 * Typed session fixtures for unit tests, built against eve's public types so
 * fixture drift after an eve upgrade fails typecheck instead of passing
 * silently through a cast.
 *
 * @packageDocumentation
 */
import type { SessionAuthContext, SessionContext } from "eve/context";
import type { ToolContext } from "eve/tools";
import type {
  ApprovalContext,
  ApprovalResponseContext,
} from "eve/tools/approval";

import type { JsonObject } from "../json";

interface SlackAuthOptions {
  channelId?: string;
  installationTeamId?: string;
  teamId?: string;
  threadTs?: string;
  userId?: string;
}

/**
 * Builds a human Slack principal using eve's workspace-qualified identity convention.
 *
 * @param options - Optional user, workspace, channel, and thread identifiers for the fixture.
 * @returns Session authentication with Slack-origin attributes used by tools and approvals.
 */
export const slackAuth = ({
  channelId = "C123",
  installationTeamId,
  teamId = "T123",
  threadTs = "1700000000.000100",
  userId = "U123",
}: SlackAuthOptions = {}): SessionAuthContext => {
  const team = installationTeamId ?? teamId;
  return {
    attributes: {
      author_type: "user",
      channel_id: channelId,
      team_id: teamId,
      thread_ts: threadTs,
      user_id: userId,
    },
    authenticator: "slack-webhook",
    issuer: `slack:${team}`,
    principalId: `slack:${team}:${userId}`,
    principalType: "user",
  };
};

/**
 * Builds authenticated user context for a turn that did not originate in Slack, such as a signed-in web app user.
 *
 * @param principalId - Stable user identity for the test.
 * @returns User authentication with no Slack thread attributes.
 */
export const webAuth = (principalId = "web-user"): SessionAuthContext => ({
  attributes: {},
  authenticator: "web-session",
  principalId,
  principalType: "user",
});

/**
 * Builds the exact principal eve's `localDev()` route auth assigns under `eve dev` and local `eve eval`.
 *
 * @returns Local-development authentication.
 */
export const localDevAuth = (): SessionAuthContext => ({
  attributes: {},
  authenticator: "local-dev",
  principalId: "local-dev",
  principalType: "local-dev",
});

interface SlackBotAuthOptions {
  botId?: string;
  channelId?: string;
  teamId?: string;
}

/**
 * Builds the per-bot service principal the Slack channel assigns to authorless bot posts, such as Slack Workflow messages.
 *
 * @param options - Optional bot, workspace, and channel identifiers.
 * @returns Service authentication matching `botPostAuth` in the Slack channel.
 */
export const slackBotAuth = ({
  botId = "B123",
  channelId = "C123",
  teamId = "T123",
}: SlackBotAuthOptions = {}): SessionAuthContext => ({
  attributes: {
    author_type: "bot",
    bot_id: botId,
    channel_id: channelId,
    team_id: teamId,
  },
  authenticator: "slack-webhook",
  issuer: `slack:${teamId}`,
  principalId: `slack:${teamId}:bot:${botId}`,
  principalType: "service",
});

interface SessionOptions {
  current?: SessionAuthContext | null;
  initiator?: SessionAuthContext | null;
}

/**
 * Builds the public session context shared by tools, approvals, and instructions.
 *
 * @param options - Current and initiating principals; both default to the same Slack user.
 * @returns Fixed session/turn identifiers and a sandbox accessor that fails if unexpectedly used.
 */
export const sessionContext = ({
  current = slackAuth(),
  initiator = current,
}: SessionOptions = {}): SessionContext => ({
  getSandbox: () => {
    throw new Error("This test does not provide a sandbox.");
  },
  session: {
    auth: { current, initiator },
    id: "session-1",
    turn: { id: "turn-1", sequence: 1 },
  },
});

/**
 * Builds a complete public tool context for invoking a tool executor directly.
 *
 * @param options - Authentication overrides and the optional model-facing tool name.
 * @returns A context with fixed call identity, cancellation signal, and explicit unsupported connection access.
 */
export const toolContext = (
  options: SessionOptions & { toolName?: string } = {}
): ToolContext => ({
  ...sessionContext(options),
  abortSignal: new AbortController().signal,
  callId: "call-1",
  getToken: () => {
    throw new Error("This test does not provide connection tokens.");
  },
  messages: [],
  requireAuth: () => {
    throw new Error("This test does not provide connection auth.");
  },
  toolName: options.toolName ?? "tool",
});

/**
 * Builds a public approval context for exercising request policies directly.
 *
 * @typeParam TInput - JSON-compatible tool input presented to the policy.
 * @param toolInput - Exact proposed input whose query or other action is being approved.
 * @param options - Authentication overrides and optional tool name.
 * @returns Approval context sharing the fixture session and a fresh cancellation signal.
 */
export const approvalContext = <TInput extends JsonObject>(
  toolInput: TInput,
  options: SessionOptions & { toolName?: string } = {}
): ApprovalContext<TInput> => ({
  ...sessionContext(options),
  abortSignal: new AbortController().signal,
  approvedTools: new Set(),
  callId: "call-1",
  // eve's conditional `ApprovalToolInput` does not resolve for a generic input.
  // SAFETY: TInput is constrained to JSON objects, which are the accepted tool-input branch of eve’s conditional approval type.
  toolInput: toolInput as ApprovalContext<TInput>["toolInput"],
  toolName: options.toolName ?? "tool",
});

interface ApprovalResponseOptions<TInput> {
  decision?: "approve" | "cancel";
  requester?: SessionAuthContext | null;
  responder?: SessionAuthContext;
  toolInput?: TInput;
  toolName?: string;
}

/**
 * Builds a public approval response context for exercising response policies directly.
 *
 * @typeParam TInput - JSON-compatible tool input recorded on the request.
 * @param options - Requesting and responding principals, decision, and request details; both principals default to the same Slack user.
 * @returns Response context whose auth capability fails if unexpectedly used.
 */
export const approvalResponseContext = <TInput extends JsonObject>({
  decision = "approve",
  requester = slackAuth(),
  responder = slackAuth(),
  toolInput,
  toolName = "tool",
}: ApprovalResponseOptions<TInput> = {}): ApprovalResponseContext<TInput> => ({
  auth: {
    getToken: () => {
      throw new Error("This test does not provide connection tokens.");
    },
    requireAuth: () => {
      throw new Error("This test does not provide connection auth.");
    },
  },
  request: {
    callId: "call-1",
    principal: requester,
    requestId: "request-1",
    // SAFETY: TInput is constrained to JSON objects, which are the accepted tool-input branch of eve's conditional approval type.
    toolInput:
      toolInput as ApprovalResponseContext<TInput>["request"]["toolInput"],
    toolName,
  },
  response: { decision, principal: responder },
  session: {
    id: "session-1",
    initiator: requester,
    turn: { id: "turn-1", sequence: 1 },
  },
});

/**
 * Narrows a value to the callable members of its declared type, such as a tool's optional `execute`.
 *
 * @typeParam T - Original union containing any callable members.
 * @param value - Value to inspect without invoking it.
 * @returns Whether the value is a function.
 */
export const isCallable = <T>(
  value: T
): value is Extract<T, (...args: never[]) => void> =>
  typeof value === "function";
