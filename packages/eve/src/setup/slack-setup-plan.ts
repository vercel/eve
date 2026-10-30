/**
 * Pure decisions for resumable Slack setup: which mutation (if any) finishes
 * event delivery and which connector setup suggests.
 */

import type {
  SlackConnectorProject,
  SlackConnectorRef,
  SlackTriggerDestination,
  SlackWorkspaceConnection,
} from "./slack-connect.js";

/** Connect rejects a fourth trigger destination on one connector. */
export const MAX_SLACK_TRIGGER_DESTINATIONS = 3;

/** A connector other projects use, which setup never attaches to this one. */
export interface SlackConnectorInUse {
  uid: string;
  otherProjects: readonly SlackConnectorProject[];
}

/** One team Slack connector as setup sees it before changing anything. */
export interface SlackConnectorCandidate extends SlackConnectorRef {
  /** Whether the linked project has token access to this connector. */
  attached: boolean;
  /** Present once the Slack app is installed into a workspace. */
  workspace?: SlackWorkspaceConnection;
  triggerDestinations: readonly SlackTriggerDestination[];
  /**
   * Other projects that use this connector, by attachment or by trigger
   * destination. Setup never changes their attachments or destinations.
   */
  otherProjects: readonly SlackConnectorProject[];
  createdAt: number;
}

/**
 * Whether setup may reuse a connector: it already belongs to this project, or
 * no other project uses it (for example, one created by hand for this agent).
 * One Slack app forwards every event to every destination, so attaching a
 * second agent would make both respond.
 */
export function isReusableSlackConnector(candidate: SlackConnectorCandidate): boolean {
  return candidate.attached || candidate.otherProjects.length === 0;
}

function isDefaultDeployment(destination: SlackTriggerDestination): boolean {
  return destination.branch === undefined && destination.customEnvironmentId === undefined;
}

function isProjectDefault(destination: SlackTriggerDestination, projectId: string): boolean {
  return destination.projectId === projectId && isDefaultDeployment(destination);
}

/**
 * What finishes event delivery for one connector. `attach` gives the project
 * token access; `destinations`, when present, is the full destination set to
 * write, changing only this project's default-deployment entry. Each half is
 * idempotent, so a run that stops between them resumes on the next one.
 */
export type SlackRoutingPlan =
  | { kind: "apply"; attach: boolean; destinations?: readonly SlackTriggerDestination[] }
  | { kind: "limit-reached"; destinations: readonly SlackTriggerDestination[] };

/**
 * Plans the routing mutation. An attached project is never re-attached,
 * because `connect attach` without `--environment` resets its environment
 * scoping.
 */
export function planSlackRouting(input: {
  attached: boolean;
  destinations: readonly SlackTriggerDestination[];
  projectId: string;
  route: string;
}): SlackRoutingPlan {
  const { attached, destinations, projectId, route } = input;
  const attach = !attached;
  const own = destinations.filter((destination) => isProjectDefault(destination, projectId));
  if (own.length === 1 && own[0]?.path === route) return { kind: "apply", attach };
  const kept = destinations.filter((destination) => !isProjectDefault(destination, projectId));
  const next = [...kept, { projectId, path: route }];
  if (next.length > MAX_SLACK_TRIGGER_DESTINATIONS) {
    return { kind: "limit-reached", destinations };
  }
  return { kind: "apply", attach, destinations: next };
}

/**
 * Orders candidates for the connector question and picks the suggestion:
 * the channel file's UID, then `slack/<slug>`, then the newest connector
 * already attached to this project. `undefined` suggests a new connector.
 */
export function orderSlackConnectorCandidates(
  candidates: readonly SlackConnectorCandidate[],
  input: { channelConnectorUid?: string | undefined; expectedUid: string },
): { candidates: SlackConnectorCandidate[]; preferred?: SlackConnectorCandidate } {
  const byNewest = [...candidates].sort((left, right) => right.createdAt - left.createdAt);
  const preferred =
    byNewest.find((candidate) => candidate.uid === input.channelConnectorUid) ??
    byNewest.find((candidate) => candidate.uid === input.expectedUid) ??
    byNewest.find((candidate) => candidate.attached);
  const rest = byNewest
    .filter((candidate) => candidate !== preferred)
    .sort((left, right) => Number(right.attached) - Number(left.attached));
  const ordered = preferred === undefined ? rest : [preferred, ...rest];
  return preferred === undefined ? { candidates: ordered } : { candidates: ordered, preferred };
}

/** Human-readable destination list for the trigger-limit report. */
export function describeSlackDestinations(
  destinations: readonly SlackTriggerDestination[],
  projectNames: ReadonlyMap<string, string>,
): string[] {
  return destinations.map((destination) => {
    const project = projectNames.get(destination.projectId) ?? destination.projectId;
    const target =
      destination.customEnvironmentId !== undefined
        ? `custom environment ${destination.customEnvironmentId}`
        : destination.branch !== undefined
          ? `branch ${destination.branch}`
          : "production";
    return `${project} (${target}) ${destination.path ?? "<default path>"}`;
  });
}
