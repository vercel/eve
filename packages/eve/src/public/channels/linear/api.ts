import {
  resolveLinearAccessToken,
  type LinearChannelCredentials,
} from "#public/channels/linear/auth.js";
import { isObject } from "#shared/guards.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export type LinearFetch = typeof fetch;

/** Transport options for Linear GraphQL calls. */
export interface LinearApiOptions {
  /** Defaults to `https://api.linear.app/graphql`. */
  readonly apiBaseUrl?: string;
  /** Test/fetch override. */
  readonly fetch?: LinearFetch;
}

export type LinearAgentActivitySignal = "auth" | "continue" | "select" | "stop";

export type LinearAgentActivityContent =
  | {
      readonly body: string;
      readonly type: "elicitation" | "error" | "response" | "thought";
    }
  | {
      readonly action: string;
      readonly parameter: string;
      readonly result?: string;
      readonly type: "action";
    };

export interface LinearAgentActivityCreateInput {
  agentSessionId: string;
  content: LinearAgentActivityContent;
  ephemeral?: boolean;
  signal?: LinearAgentActivitySignal;
  signalMetadata?: JsonObject;
}

export interface LinearExternalUrl {
  label: string;
  url: string;
}

export interface LinearAgentSessionUpdateInput {
  addedExternalUrls?: readonly LinearExternalUrl[];
  externalLink?: string;
  externalUrls?: readonly LinearExternalUrl[];
  plan?: JsonObject;
  removedExternalUrls?: readonly string[];
}

export interface LinearAgentSessionRecord {
  appUserId?: string;
  commentId?: string | null;
  creatorId?: string | null;
  id: string;
  issue?: {
    id: string;
    identifier?: string;
    title?: string;
    url?: string;
  } | null;
  issueId?: string | null;
  organizationId?: string;
  sourceCommentId?: string | null;
  status?: string;
  url?: string | null;
}

export interface LinearAgentActivityRecord {
  content: {
    body?: string;
    type?: string;
    __typename?: string;
  };
  id: string;
  updatedAt?: string;
}

export class LinearApiError extends Error {
  readonly body: unknown;
  readonly queryName: string;
  readonly status: number;

  constructor(input: {
    readonly body: unknown;
    readonly queryName: string;
    readonly status: number;
  }) {
    super(`Linear GraphQL ${input.queryName} failed with HTTP ${input.status}.`);
    this.name = "LinearApiError";
    this.body = input.body;
    this.queryName = input.queryName;
    this.status = input.status;
  }
}

export async function callLinearGraphQL<T>(input: {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
  readonly query: string;
  readonly queryName: string;
  readonly variables?: JsonObject;
}): Promise<T> {
  const apiFetch = input.api?.fetch ?? fetch;
  const token = await resolveLinearAccessToken(input.credentials?.accessToken);
  const response = await apiFetch(input.api?.apiBaseUrl ?? "https://api.linear.app/graphql", {
    body: JSON.stringify({
      query: input.query,
      variables: input.variables ?? {},
    }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    method: "POST",
  });

  const body = await parseResponseBody(response);
  if (!response.ok || hasGraphQLErrors(body)) {
    throw new LinearApiError({ body, queryName: input.queryName, status: response.status });
  }

  if (!isObject(body) || !isObject(body.data)) {
    throw new LinearApiError({ body, queryName: input.queryName, status: response.status });
  }
  return body.data as T;
}

/** Emits one semantic Agent Activity into a Linear Agent Session. */
export async function createLinearAgentActivity(input: {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
  readonly activity: LinearAgentActivityCreateInput;
}): Promise<{ readonly id: string; readonly success: boolean }> {
  const data = await callLinearGraphQL<{
    readonly agentActivityCreate?: {
      readonly agentActivity?: { readonly id?: unknown };
      readonly success?: unknown;
    };
  }>({
    api: input.api,
    credentials: input.credentials,
    query: `
      mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
          agentActivity { id }
        }
      }
    `,
    queryName: "AgentActivityCreate",
    variables: { input: parseJsonObject(input.activity) },
  });

  const payload = data.agentActivityCreate;
  const id = payload?.agentActivity?.id;
  return {
    id: typeof id === "string" ? id : "",
    success: payload?.success === true,
  };
}

/** Updates mutable Agent Session fields such as external URLs and plan. */
export async function updateLinearAgentSession(input: {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
  readonly id: string;
  readonly update: LinearAgentSessionUpdateInput;
}): Promise<{ readonly success: boolean }> {
  const data = await callLinearGraphQL<{
    readonly agentSessionUpdate?: { readonly success?: unknown };
  }>({
    api: input.api,
    credentials: input.credentials,
    query: `
      mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) {
          success
        }
      }
    `,
    queryName: "AgentSessionUpdate",
    variables: {
      id: input.id,
      input: parseJsonObject(input.update),
    },
  });

  return { success: data.agentSessionUpdate?.success === true };
}

/** Creates a proactive Agent Session attached to a Linear issue. */
export async function createLinearAgentSessionOnIssue(input: {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
  readonly issueId: string;
  readonly externalLink?: string;
  readonly externalUrls?: readonly LinearExternalUrl[];
}): Promise<LinearAgentSessionRecord> {
  const data = await callLinearGraphQL<{
    readonly agentSessionCreateOnIssue?: {
      readonly agentSession?: unknown;
      readonly success?: unknown;
    };
  }>({
    api: input.api,
    credentials: input.credentials,
    query: `
      mutation AgentSessionCreateOnIssue($input: AgentSessionCreateOnIssue!) {
        agentSessionCreateOnIssue(input: $input) {
          success
          agentSession {
            id
            appUserId
            commentId
            creator { id }
            issue { id identifier title url }
            issueId
            organizationId
            sourceCommentId
            status
            url
          }
        }
      }
    `,
    queryName: "AgentSessionCreateOnIssue",
    variables: {
      input: parseJsonObject({
        externalLink: input.externalLink,
        externalUrls: input.externalUrls,
        issueId: input.issueId,
      }),
    },
  });

  return normalizeAgentSessionRecord(data.agentSessionCreateOnIssue?.agentSession);
}

/** Creates a proactive Agent Session attached to a Linear root comment. */
export async function createLinearAgentSessionOnComment(input: {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
  readonly commentId: string;
  readonly externalLink?: string;
  readonly externalUrls?: readonly LinearExternalUrl[];
}): Promise<LinearAgentSessionRecord> {
  const data = await callLinearGraphQL<{
    readonly agentSessionCreateOnComment?: {
      readonly agentSession?: unknown;
      readonly success?: unknown;
    };
  }>({
    api: input.api,
    credentials: input.credentials,
    query: `
      mutation AgentSessionCreateOnComment($input: AgentSessionCreateOnComment!) {
        agentSessionCreateOnComment(input: $input) {
          success
          agentSession {
            id
            appUserId
            commentId
            creator { id }
            issue { id identifier title url }
            issueId
            organizationId
            sourceCommentId
            status
            url
          }
        }
      }
    `,
    queryName: "AgentSessionCreateOnComment",
    variables: {
      input: parseJsonObject({
        commentId: input.commentId,
        externalLink: input.externalLink,
        externalUrls: input.externalUrls,
      }),
    },
  });

  return normalizeAgentSessionRecord(data.agentSessionCreateOnComment?.agentSession);
}

/** Reads recent Agent Activities for reconstructing Linear-native HITL replies. */
export async function listLinearAgentSessionActivities(input: {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
  readonly agentSessionId: string;
  readonly last?: number;
}): Promise<readonly LinearAgentActivityRecord[]> {
  const data = await callLinearGraphQL<{
    readonly agentSession?: {
      readonly activities?: {
        readonly nodes?: unknown;
      };
    };
  }>({
    api: input.api,
    credentials: input.credentials,
    query: `
      query AgentSessionActivities($id: String!, $last: Int!) {
        agentSession(id: $id) {
          activities(last: $last) {
            nodes {
              id
              updatedAt
              content {
                __typename
                ... on AgentActivityElicitationContent { body type }
                ... on AgentActivityPromptContent { body type }
                ... on AgentActivityResponseContent { body type }
                ... on AgentActivityThoughtContent { body type }
                ... on AgentActivityErrorContent { body type }
              }
            }
          }
        }
      }
    `,
    queryName: "AgentSessionActivities",
    variables: { id: input.agentSessionId, last: input.last ?? 20 },
  });

  const nodes = data.agentSession?.activities?.nodes;
  return Array.isArray(nodes) ? nodes.map(normalizeAgentActivityRecord).filter(notNull) : [];
}

function normalizeAgentSessionRecord(value: unknown): LinearAgentSessionRecord {
  if (!isObject(value) || typeof value.id !== "string") {
    throw new Error("linearChannel: Linear Agent Session response was malformed.");
  }

  const creator = isObject(value.creator) ? value.creator : undefined;
  const issue = normalizeIssue(value.issue);
  const record: LinearAgentSessionRecord = { id: value.id };
  if (typeof value.appUserId === "string") record.appUserId = value.appUserId;
  if (typeof value.commentId === "string" || value.commentId === null) {
    record.commentId = value.commentId;
  }
  if (typeof creator?.id === "string" || creator === undefined) {
    record.creatorId = typeof creator?.id === "string" ? creator.id : null;
  }
  if (issue !== undefined) record.issue = issue;
  if (typeof value.issueId === "string" || value.issueId === null) record.issueId = value.issueId;
  if (typeof value.organizationId === "string") record.organizationId = value.organizationId;
  if (typeof value.sourceCommentId === "string" || value.sourceCommentId === null) {
    record.sourceCommentId = value.sourceCommentId;
  }
  if (typeof value.status === "string") record.status = value.status;
  if (typeof value.url === "string" || value.url === null) record.url = value.url;
  return record;
}

function normalizeAgentActivityRecord(value: unknown): LinearAgentActivityRecord | null {
  if (!isObject(value) || typeof value.id !== "string" || !isObject(value.content)) return null;

  const content: LinearAgentActivityRecord["content"] = {};
  if (typeof value.content.body === "string") content.body = value.content.body;
  if (typeof value.content.type === "string") content.type = value.content.type;
  if (typeof value.content.__typename === "string") content.__typename = value.content.__typename;

  const record: LinearAgentActivityRecord = {
    content,
    id: value.id,
  };
  if (typeof value.updatedAt === "string") record.updatedAt = value.updatedAt;
  return record;
}

function normalizeIssue(value: unknown): LinearAgentSessionRecord["issue"] | undefined {
  if (value === null) return null;
  if (!isObject(value) || typeof value.id !== "string") return undefined;
  const issue: NonNullable<LinearAgentSessionRecord["issue"]> = { id: value.id };
  if (typeof value.identifier === "string") issue.identifier = value.identifier;
  if (typeof value.title === "string") issue.title = value.title;
  if (typeof value.url === "string") issue.url = value.url;
  return issue;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function hasGraphQLErrors(body: unknown): boolean {
  return isObject(body) && Array.isArray(body.errors) && body.errors.length > 0;
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}
