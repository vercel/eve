import type { UserContent } from "ai";

import { isObject } from "#shared/guards.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

/** Linear Agent Session webhook actions supported by the channel. */
export type LinearAgentSessionAction = "created" | "prompted" | (string & {});

/** Verified Linear webhook delivery headers. */
export interface LinearDelivery {
  event: string | undefined;
  id: string | undefined;
}

/** Linear actor projected from webhook payload user/creator fields. */
export interface LinearUser {
  id: string;
  displayName?: string;
  name?: string;
  email?: string;
  url?: string;
}

/** Linear issue context attached to an Agent Session. */
export interface LinearIssueRef {
  id: string;
  identifier?: string;
  title?: string;
  url?: string;
}

/** Linear Agent Session snapshot carried by Agent Session webhooks. */
export interface LinearAgentSessionRef {
  appUserId?: string;
  commentId?: string | null;
  creator?: LinearUser;
  creatorId?: string | null;
  id: string;
  issue?: LinearIssueRef | null;
  issueId?: string | null;
  organizationId?: string;
  sourceCommentId?: string | null;
  status?: string;
  summary?: string | null;
  url?: string | null;
}

/** Linear Agent Activity snapshot carried by `prompted` webhooks. */
export interface LinearAgentActivityRef {
  body?: string;
  content: JsonObject;
  id: string;
  signal?: string | null;
  signalMetadata?: JsonObject | null;
  sourceCommentId?: string | null;
  user?: LinearUser;
  userId?: string | null;
}

/** Parsed Linear Agent Session event consumed by `linearChannel`. */
export interface LinearAgentSessionEvent {
  readonly action: LinearAgentSessionAction;
  readonly agentActivity?: LinearAgentActivityRef;
  readonly agentSession: LinearAgentSessionRef;
  readonly appUserId?: string;
  readonly createdAt?: string;
  readonly delivery: LinearDelivery;
  readonly guidance?: string;
  readonly kind: "agent_session";
  readonly oauthClientId?: string;
  readonly organizationId?: string;
  readonly previousComments: readonly string[];
  readonly promptContext?: string;
  readonly raw: JsonObject;
}

/** Parsed generic Linear data webhook event. */
export interface LinearDataWebhookEvent {
  readonly action?: string;
  readonly delivery: LinearDelivery;
  readonly kind: "data";
  readonly organizationId?: string;
  readonly raw: JsonObject;
  readonly type: string;
}

/** Parsed Linear webhook event shape consumed by the channel. */
export type LinearInboundEvent = LinearAgentSessionEvent | LinearDataWebhookEvent;

/** Builds the continuation token for one Linear Agent Session. */
export function linearContinuationToken(agentSessionId: string): string {
  return `agent-session:${agentSessionId}`;
}

/** Parses a verified Linear webhook body into a normalized event, or `null` when unsupported. */
export function parseLinearWebhookEvent(input: {
  readonly body: string;
  readonly headers: Headers;
}): LinearInboundEvent | null {
  const raw = parseJsonObject(JSON.parse(input.body) as unknown);
  const delivery: LinearDelivery = {
    event: input.headers.get("linear-event") ?? undefined,
    id: input.headers.get("linear-delivery") ?? undefined,
  };
  const type = readString(raw.type);
  if (!type) return null;

  if (type === "AgentSessionEvent") {
    const agentSession = readAgentSession(raw.agentSession);
    if (agentSession === null) return null;
    return {
      action: readString(raw.action) ?? "created",
      agentActivity: readAgentActivity(raw.agentActivity),
      agentSession,
      appUserId: readString(raw.appUserId),
      createdAt: readString(raw.createdAt),
      delivery,
      guidance: readString(raw.guidance),
      kind: "agent_session",
      oauthClientId: readString(raw.oauthClientId),
      organizationId: readString(raw.organizationId),
      previousComments: readPreviousComments(raw.previousComments),
      promptContext: readString(raw.promptContext),
      raw,
    };
  }

  return {
    action: readString(raw.action),
    delivery,
    kind: "data",
    organizationId: readString(raw.organizationId),
    raw,
    type,
  };
}

/** Builds the user-facing message for a Linear Agent Session event. */
export function messageFromLinearAgentSessionEvent(event: LinearAgentSessionEvent): UserContent {
  if (event.action === "prompted") {
    const body = event.agentActivity?.body;
    if (body !== undefined && body.trim().length > 0) return body;
  }

  const prompt = event.promptContext?.trim();
  if (prompt !== undefined && prompt.length > 0) return prompt;

  const summary = event.agentSession.summary?.trim();
  if (summary !== undefined && summary.length > 0) return summary;

  const issue = event.agentSession.issue;
  if (issue?.title) {
    const identifier = issue.identifier ? `${issue.identifier}: ` : "";
    return `${identifier}${issue.title}`;
  }

  return "Linear agent session started.";
}

/** Formats Linear issue/session context as an eve context block. */
export function formatLinearContextBlock(event: LinearAgentSessionEvent): string {
  const session = event.agentSession;
  const issue = session.issue;
  const lines = [
    "<linear_context>",
    `action: ${event.action}`,
    `agent_session_id: ${session.id}`,
    `agent_session_url: ${session.url ?? ""}`,
    `organization_id: ${event.organizationId ?? session.organizationId ?? ""}`,
    `issue_id: ${session.issueId ?? issue?.id ?? ""}`,
    `issue_identifier: ${issue?.identifier ?? ""}`,
    `issue_title: ${issue?.title ?? ""}`,
    `issue_url: ${issue?.url ?? ""}`,
    `comment_id: ${session.commentId ?? ""}`,
    `source_comment_id: ${session.sourceCommentId ?? ""}`,
    "response_medium: linear_agent_activity",
    "</linear_context>",
  ];
  return lines.join("\n");
}

function readAgentSession(value: unknown): LinearAgentSessionRef | null {
  if (!isObject(value) || typeof value.id !== "string") return null;
  const session: LinearAgentSessionRef = { id: value.id };
  if (typeof value.appUserId === "string") session.appUserId = value.appUserId;
  if (typeof value.commentId === "string" || value.commentId === null) {
    session.commentId = value.commentId;
  }
  session.creator = readUser(value.creator);
  if (typeof value.creatorId === "string" || value.creatorId === null) {
    session.creatorId = value.creatorId;
  }
  const issue = readIssue(value.issue);
  if (issue !== undefined) session.issue = issue;
  if (typeof value.issueId === "string" || value.issueId === null) session.issueId = value.issueId;
  if (typeof value.organizationId === "string") session.organizationId = value.organizationId;
  if (typeof value.sourceCommentId === "string" || value.sourceCommentId === null) {
    session.sourceCommentId = value.sourceCommentId;
  }
  if (typeof value.status === "string") session.status = value.status;
  if (typeof value.summary === "string" || value.summary === null) session.summary = value.summary;
  if (typeof value.url === "string" || value.url === null) session.url = value.url;
  return session;
}

function readAgentActivity(value: unknown): LinearAgentActivityRef | undefined {
  if (!isObject(value) || typeof value.id !== "string") return undefined;
  const content = isObject(value.content) ? parseJsonObject(value.content) : {};
  const activity: LinearAgentActivityRef = {
    body: readActivityBody(value.content),
    content,
    id: value.id,
  };
  if (typeof value.signal === "string" || value.signal === null) activity.signal = value.signal;
  if (isObject(value.signalMetadata))
    activity.signalMetadata = parseJsonObject(value.signalMetadata);
  if (value.signalMetadata === null) activity.signalMetadata = null;
  if (typeof value.sourceCommentId === "string" || value.sourceCommentId === null) {
    activity.sourceCommentId = value.sourceCommentId;
  }
  activity.user = readUser(value.user);
  if (typeof value.userId === "string" || value.userId === null) activity.userId = value.userId;
  return activity;
}

function readActivityBody(content: unknown): string | undefined {
  if (!isObject(content)) return undefined;
  return readString(content.body);
}

function readIssue(value: unknown): LinearIssueRef | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || typeof value.id !== "string") return undefined;
  const issue: LinearIssueRef = { id: value.id };
  if (typeof value.identifier === "string") issue.identifier = value.identifier;
  if (typeof value.title === "string") issue.title = value.title;
  if (typeof value.url === "string") issue.url = value.url;
  return issue;
}

function readUser(value: unknown): LinearUser | undefined {
  if (!isObject(value) || typeof value.id !== "string") return undefined;
  const user: LinearUser = { id: value.id };
  if (typeof value.displayName === "string") user.displayName = value.displayName;
  if (typeof value.name === "string") user.name = value.name;
  if (typeof value.email === "string") user.email = value.email;
  if (typeof value.url === "string") user.url = value.url;
  return user;
}

function readPreviousComments(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (isObject(entry) && typeof entry.body === "string") return entry.body;
      return null;
    })
    .filter((entry): entry is string => entry !== null);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
