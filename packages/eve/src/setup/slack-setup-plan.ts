import type {
  SlackConnectorProject,
  SlackConnectorRef,
  SlackTriggerDestination,
  SlackWorkspaceConnection,
} from "./slack-connect.js";

export const MAX_SLACK_TRIGGER_DESTINATIONS = 3;

export interface SlackConnectorInUse {
  uid: string;
  otherProjects: readonly SlackConnectorProject[];
}

export interface SlackConnectorCandidate extends SlackConnectorRef {
  attached: boolean;
  workspace?: SlackWorkspaceConnection;
  triggerDestinations: readonly SlackTriggerDestination[];
  otherProjects: readonly SlackConnectorProject[];
  createdAt: number;
}

export function isReusableSlackConnector(candidate: SlackConnectorCandidate): boolean {
  return candidate.attached || candidate.otherProjects.length === 0;
}

function isDefaultDeployment(destination: SlackTriggerDestination): boolean {
  return destination.branch === undefined && destination.customEnvironmentId === undefined;
}

function isProjectDefault(destination: SlackTriggerDestination, projectId: string): boolean {
  return destination.projectId === projectId && isDefaultDeployment(destination);
}

export type SlackRoutingPlan =
  | { kind: "apply"; attach: boolean; destinations?: readonly SlackTriggerDestination[] }
  | { kind: "limit-reached"; destinations: readonly SlackTriggerDestination[] };

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
