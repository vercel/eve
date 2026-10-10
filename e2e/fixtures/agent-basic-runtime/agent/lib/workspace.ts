import { defineState, type SessionAuthContext } from "eve/context";

/**
 * Workspace member directory. A deployed agent would read members from its
 * identity provider and their credentials from a secret store.
 */
interface WorkspaceMember {
  /** Absent when the member's credential grant was revoked. */
  readonly credentials?: WorkspaceCredentials;
  readonly auditSink: "reachable" | "unreachable";
}

export interface WorkspaceCredentials {
  readonly token: string;
}

const MEMBERS: Readonly<Record<string, WorkspaceMember>> = {
  alice: { auditSink: "reachable", credentials: { token: "alice-workspace-token" } },
  bob: { auditSink: "reachable" },
  carol: { auditSink: "unreachable", credentials: { token: "carol-workspace-token" } },
};

const AUTHENTICATOR = "workspace";
const TOKEN_PREFIX = "Bearer workspace-";

/** Resolves a workspace member from their bearer token. */
export function authenticateWorkspaceMember(
  authorization: string | null,
): SessionAuthContext | null {
  const name = authorization?.startsWith(TOKEN_PREFIX)
    ? authorization.slice(TOKEN_PREFIX.length)
    : undefined;
  if (name === undefined || MEMBERS[name] === undefined) return null;
  return {
    attributes: {},
    authenticator: AUTHENTICATOR,
    issuer: "workspace",
    principalId: name,
    principalType: "user",
    subject: name,
  };
}

function findMember(principal: SessionAuthContext | null): [string, WorkspaceMember] | undefined {
  const name = principal?.authenticator === AUTHENTICATOR ? principal.subject : undefined;
  const member = name === undefined ? undefined : MEMBERS[name];
  return name === undefined || member === undefined ? undefined : [name, member];
}

/** True for callers who signed in as workspace members. */
export function isWorkspaceMember(principal: SessionAuthContext | null): boolean {
  return findMember(principal) !== undefined;
}

/** Loads the caller's workspace credentials; callers outside the workspace need none. */
export async function loadWorkspaceCredentials(
  principal: SessionAuthContext | null,
): Promise<WorkspaceCredentials | undefined> {
  const found = findMember(principal);
  if (found === undefined) return undefined;
  const [name, member] = found;
  if (member.credentials === undefined) {
    throw new Error(`The workspace credential grant for ${name} was revoked.`);
  }
  return member.credentials;
}

/** Sends one event to the caller's workspace audit sink. */
export async function exportAuditEvent(
  principal: SessionAuthContext | null,
  event: { readonly type: string },
): Promise<void> {
  const found = findMember(principal);
  if (found === undefined) return;
  const [name, member] = found;
  if (member.auditSink === "unreachable") {
    throw new Error(`The audit sink for ${name}'s workspace is unreachable (${event.type}).`);
  }
}

export interface QueuedAuditEvent {
  readonly eventId: string;
  readonly type: string;
}

/** Audit events kept for retry while the workspace audit sink is unreachable. */
export const auditOutbox = defineState<QueuedAuditEvent[]>("basic-runtime.audit-outbox", () => []);
