import { createLogger } from "#internal/logging.js";
import { buildSlackWorkspaceHandle } from "#public/channels/slack/api.js";
import type {
  SlackChannelConfig,
  SlackRawInteraction,
  SlackRawInteractionContext,
} from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.interactions");

export async function handleRawInteraction(
  raw: unknown,
  fallbackType: string,
  waitUntil: (task: Promise<unknown>) => void,
  config: SlackChannelConfig,
  fallbackResponse: Response,
): Promise<Response> {
  const handler = config.onRawInteraction;
  if (handler === undefined || !isObjectRecord(raw)) {
    log.warn("unsupported Slack interaction payload ignored", { type: fallbackType });
    return fallbackResponse;
  }

  const type = readOptionalString(raw.type) ?? fallbackType;
  const userBlock = isObjectRecord(raw.user) ? raw.user : undefined;
  const teamBlock = isObjectRecord(raw.team) ? raw.team : undefined;
  const enterpriseBlock = isObjectRecord(raw.enterprise) ? raw.enterprise : undefined;
  const userId = readOptionalString(userBlock?.id);
  const teamId =
    readOptionalString(userBlock?.team_id) ??
    readOptionalString(teamBlock?.id) ??
    readOptionalString(raw.team_id);
  const installationTeamId = readInstallationTeamId(raw);
  const enterpriseId =
    readOptionalString(enterpriseBlock?.id) ?? readOptionalString(raw.enterprise_id);
  const interaction: {
    -readonly [K in keyof SlackRawInteraction]: SlackRawInteraction[K];
  } = { type, payload: raw };
  if (userId !== undefined) {
    interaction.user = {
      id: userId,
      username: readOptionalString(userBlock?.username),
      name: readOptionalString(userBlock?.name),
    };
  }
  if (teamId !== undefined) interaction.teamId = teamId;
  if (installationTeamId !== undefined) interaction.installationTeamId = installationTeamId;
  if (enterpriseId !== undefined) interaction.enterpriseId = enterpriseId;

  const ctx: SlackRawInteractionContext = {
    slack: buildSlackWorkspaceHandle({
      botToken: config.credentials?.botToken,
      installationTeamId,
      teamId,
    }),
    waitUntil,
  };

  try {
    return (await handler(interaction, ctx)) ?? new Response(null, { status: 200 });
  } catch (error) {
    log.error("raw interaction handler failed", { error });
    return fallbackResponse;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readInstallationTeamId(value: Record<string, unknown>): string | undefined {
  const view = isObjectRecord(value.view) ? value.view : undefined;
  const team = isObjectRecord(value.team) ? value.team : undefined;
  const user = isObjectRecord(value.user) ? value.user : undefined;
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
