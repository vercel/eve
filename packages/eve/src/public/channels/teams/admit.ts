/**
 * Teams admission: the one check every Teams surface passes before a hook
 * runs or eve posts somewhere new. The default keeps the agent out of
 * conversations that include another Microsoft Entra tenant and away from
 * guest and anonymous accounts.
 */
import { createLogger, logError } from "#internal/logging.js";
import {
  callTeamsConnectorApi,
  normalizeTeamsContinuationAddress,
  resolveTeamsTenantId,
  type TeamsApiOptions,
} from "#public/channels/teams/api.js";
import type { TeamsActivityBase } from "#public/channels/teams/inbound.js";
import type { TeamsHandle } from "#public/channels/teams/teamsChannel.js";
import { isObject } from "#shared/guards.js";

const log = createLogger("teams.admit");

/** The Teams surface asking to reach the agent. */
export type TeamsAdmitKind = "message" | "answer" | "invoke" | "send";

/** The Teams user behind an inbound request. */
export interface TeamsAdmitActor {
  /** The Bot Framework user id (`29:...`), the same as `activity.from.id`. */
  readonly userId: string;
  /** The user's Microsoft Entra object id, when Teams reported one. */
  readonly aadObjectId?: string;
}

/** What `teamsChannel({ admit })` decides on. */
export interface TeamsAdmitRequest {
  /**
   * The surface asking: a message, an answer to an approval, question, or
   * sign-in card, an `onInvoke` activity, or an outbound `send` that starts a
   * session in a conversation.
   */
  readonly kind: TeamsAdmitKind;
  /** The conversation the request comes from, or that `send` posts into. */
  readonly conversationId: string;
  /** `personal`, `groupChat`, `channel`, or another Teams value, when known. */
  readonly conversationType: string | undefined;
  /** The Microsoft Entra tenant the conversation belongs to, when known. */
  readonly tenantId: string | undefined;
  /** The Teams user behind the request. `undefined` for `send`. */
  readonly actor: TeamsAdmitActor | undefined;
  /**
   * Whether the conversation reaches beyond its tenant: it names no tenant or
   * conflicting ones, it belongs to a tenant other than the configured
   * `credentials.tenantId`, Teams marks it as a shared channel, or the actor
   * belongs to another tenant. Returns `true` when Teams can't classify it.
   * Memoized per request.
   */
  isExternalConversation(): Promise<boolean>;
  /**
   * Whether the actor is a guest or an anonymous participant, by the
   * conversation member's `userRole`. Returns `true` when Teams can't say, and
   * `false` without an actor. Memoized per request and cached briefly per user.
   */
  isGuest(): Promise<boolean>;
  /** The verified Bot Framework activity, or the receive target for `send`. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Bot Connector access for the conversation. */
  readonly teams: TeamsHandle;
}

/** Decides whether a Teams request may reach the agent. Throwing counts as `false`. */
export type TeamsAdmit = (request: TeamsAdmitRequest) => boolean | Promise<boolean>;

/**
 * Default `admit`: refuses requests from, and sends into, conversations that
 * include another tenant, and refuses requests from guest and anonymous
 * accounts. Conversations and users Teams can't classify are refused too.
 */
export async function defaultTeamsAdmit(request: TeamsAdmitRequest): Promise<boolean> {
  if (await request.isExternalConversation()) return false;
  return !(await request.isGuest());
}

/** What the Bot Connector reports about one conversation member. */
interface TeamsMemberFacts {
  readonly tenantId: string | undefined;
  readonly userRole: string | undefined;
}

const MEMBER_TTL_MS = 5 * 60_000;
/** A failed lookup is retried after this, so a broken install doesn't call Teams per request. */
const FAILED_LOOKUP_TTL_MS = 60_000;
const MAX_CACHED_MEMBERS = 1_000;
// A member's role and tenant change rarely, but they do change, so answers expire.
const members = new Map<
  string,
  { readonly facts: TeamsMemberFacts | null; readonly expiresAtMs: number }
>();

function cacheMember(key: string, facts: TeamsMemberFacts | null): void {
  const now = Date.now();
  if (members.size >= MAX_CACHED_MEMBERS) {
    for (const [cachedKey, cached] of members) {
      if (cached.expiresAtMs <= now) members.delete(cachedKey);
    }
    // Map iteration is insertion order, so this drops the oldest answer.
    if (members.size >= MAX_CACHED_MEMBERS) members.delete(members.keys().next().value!);
  }
  members.set(key, {
    facts,
    expiresAtMs: now + (facts === null ? FAILED_LOOKUP_TTL_MS : MEMBER_TTL_MS),
  });
}

/**
 * Looks up one conversation member. Channel rosters live on the team, as the
 * Bot Framework SDKs read them; chats keep their own. `null` means Teams
 * couldn't say.
 */
async function lookUpMember(input: {
  readonly api: TeamsApiOptions;
  readonly conversationId: string;
  readonly serviceUrl: string;
  readonly teamId: string | undefined;
  readonly tenantId: string | undefined;
  readonly userId: string;
}): Promise<TeamsMemberFacts | null> {
  const roster = input.teamId ?? input.conversationId;
  const key = `${input.tenantId ?? ""}:${roster}:${input.userId}`;
  const cached = members.get(key);
  if (cached !== undefined && cached.expiresAtMs > Date.now()) return cached.facts;

  try {
    const response = await callTeamsConnectorApi({
      ...input.api,
      method: "GET",
      path: `/v3/conversations/${encodeURIComponent(roster)}/members/${encodeURIComponent(input.userId)}`,
      serviceUrl: input.serviceUrl,
    });
    if (!response.ok || !isObject(response.body)) {
      log.error("Teams member lookup failed, so eve treats the user as external", {
        status: response.status,
      });
      cacheMember(key, null);
      return null;
    }
    const facts = {
      tenantId: readString(response.body.tenantId),
      userRole: readString(response.body.userRole),
    };
    cacheMember(key, facts);
    return facts;
  } catch (error) {
    logError(log, "Teams member lookup failed, so eve treats the user as external", error);
    cacheMember(key, null);
    return null;
  }
}

/** Whether a member's role puts them outside the organization. */
function isGuestRole(userRole: string | undefined): boolean {
  return userRole === "guest" || userRole === "anonymous";
}

/** Builds the request `admit` sees for an inbound activity. */
export function createTeamsActivityAdmitRequest(input: {
  readonly kind: Exclude<TeamsAdmitKind, "send">;
  readonly activity: TeamsActivityBase;
  readonly api: TeamsApiOptions;
  readonly teams: TeamsHandle;
}): TeamsAdmitRequest {
  const { activity } = input;
  const conversationId = normalizeTeamsContinuationAddress({
    conversationId: activity.conversation.id,
  }).conversationId;
  const actor: TeamsAdmitActor =
    activity.from.aadObjectId === undefined
      ? { userId: activity.from.id }
      : { userId: activity.from.id, aadObjectId: activity.from.aadObjectId };
  let member: Promise<TeamsMemberFacts | null> | undefined;
  const memberFacts = () =>
    (member ??= lookUpMember({
      api: input.api,
      conversationId,
      serviceUrl: activity.serviceUrl,
      teamId: activity.teamId,
      tenantId: activity.tenantId,
      userId: activity.from.id,
    }));
  let external: Promise<boolean> | undefined;
  let guest: Promise<boolean> | undefined;

  return {
    kind: input.kind,
    conversationId,
    conversationType: activity.conversationType ?? activity.conversation.conversationType,
    tenantId: activity.tenantId,
    actor,
    isExternalConversation: () =>
      (external ??= (async () => {
        if (await isExternalTenant(activity.tenantId, input.api)) return true;
        const channelDataTenant = readNested(activity.channelData, "tenant", "id");
        const conversationTenant = activity.conversation.tenantId;
        if (
          channelDataTenant !== undefined &&
          conversationTenant !== undefined &&
          channelDataTenant !== conversationTenant
        ) {
          return true;
        }
        // Shared channels can include people from other tenants.
        if (readNested(activity.channelData, "channel", "type") === "shared") return true;
        const reportedTenant = readString((activity.raw.from as { tenantId?: unknown })?.tenantId);
        if (reportedTenant !== undefined && reportedTenant !== activity.tenantId) return true;
        const facts = await memberFacts();
        return (
          facts === null || (facts.tenantId !== undefined && facts.tenantId !== activity.tenantId)
        );
      })()),
    isGuest: () =>
      (guest ??= memberFacts().then((facts) => facts === null || isGuestRole(facts.userRole))),
    raw: activity.raw,
    teams: input.teams,
  };
}

/** Builds the request `admit` sees for a `receive` send. */
export function createTeamsSendAdmitRequest(input: {
  readonly api: TeamsApiOptions;
  readonly conversationId: string;
  readonly conversationType: string | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly teams: TeamsHandle;
  readonly tenantId: string | undefined;
}): TeamsAdmitRequest {
  let external: Promise<boolean> | undefined;
  return {
    kind: "send",
    conversationId: input.conversationId,
    conversationType: input.conversationType,
    tenantId: input.tenantId,
    actor: undefined,
    isExternalConversation: () => (external ??= isExternalTenant(input.tenantId, input.api)),
    isGuest: () => Promise.resolve(false),
    raw: input.raw,
    teams: input.teams,
  };
}

/**
 * Whether a conversation's tenant is missing or isn't the configured one. A
 * multi-tenant bot without `credentials.tenantId` admits whichever tenant
 * installed it.
 */
async function isExternalTenant(
  tenantId: string | undefined,
  api: TeamsApiOptions,
): Promise<boolean> {
  if (tenantId === undefined) return true;
  try {
    const home = await resolveTeamsTenantId(api.credentials?.tenantId);
    return home !== undefined && home !== tenantId;
  } catch (error) {
    logError(
      log,
      "Teams tenant id could not be resolved, so eve treats the conversation as external",
      error,
    );
    return true;
  }
}

/** Runs `admit`, treating a throw as a refusal. Logs refusals without content. */
export async function isTeamsRequestAdmitted(
  admit: TeamsAdmit,
  request: TeamsAdmitRequest,
): Promise<boolean> {
  let admitted = false;
  try {
    admitted = (await admit(request)) === true;
  } catch (error) {
    logError(log, "Teams admit hook failed; refusing the request", error, {
      conversationId: request.conversationId,
      kind: request.kind,
    });
    return false;
  }
  if (!admitted) {
    log.info("Teams request not admitted", {
      conversationId: request.conversationId,
      kind: request.kind,
    });
  }
  return admitted;
}

function readNested(
  value: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  const nested = value[key];
  return isObject(nested) ? readString(nested[field]) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
