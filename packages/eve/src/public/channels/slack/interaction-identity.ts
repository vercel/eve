import type { SlackInteractionUser } from "#public/channels/slack/slackChannel.js";

export interface SlackInteractionIdentity {
  readonly enterpriseId: string | undefined;
  readonly installationTeamId: string | undefined;
  readonly teamId: string | undefined;
  readonly user: SlackInteractionUser | undefined;
}

export function readSlackInteractionIdentity(raw: unknown): SlackInteractionIdentity {
  if (!isObjectRecord(raw)) {
    return {
      enterpriseId: undefined,
      installationTeamId: undefined,
      teamId: undefined,
      user: undefined,
    };
  }

  const userBlock = isObjectRecord(raw.user) ? raw.user : undefined;
  const teamBlock = isObjectRecord(raw.team) ? raw.team : undefined;
  const enterpriseBlock = isObjectRecord(raw.enterprise) ? raw.enterprise : undefined;
  const userId = readOptionalString(userBlock?.id);

  return {
    enterpriseId: readOptionalString(enterpriseBlock?.id) ?? readOptionalString(raw.enterprise_id),
    installationTeamId: readSlackInstallationTeamId(raw),
    teamId:
      readOptionalString(userBlock?.team_id) ??
      readOptionalString(teamBlock?.id) ??
      readOptionalString(raw.team_id),
    user:
      userId === undefined
        ? undefined
        : {
            id: userId,
            username: readOptionalString(userBlock?.username),
            name: readOptionalString(userBlock?.name),
          },
  };
}

export function readSlackInstallationTeamId(value: unknown): string | undefined {
  if (!isObjectRecord(value)) return undefined;
  const view = isObjectRecord(value.view) ? value.view : undefined;
  const team = isObjectRecord(value.team) ? value.team : undefined;
  const user = isObjectRecord(value.user) ? value.user : undefined;
  // Slack Connect modal submissions put the installation workspace on the
  // nested view, so it must win over the workspace that submitted the view.
  const candidates = [
    view?.app_installed_team_id,
    value.app_installed_team_id,
    team?.id,
    user?.team_id,
    view?.team_id,
  ];
  return candidates.find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
