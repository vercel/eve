/**
 * Pure parsers for Vercel Connect CLI/API payloads used by Slackbot
 * provisioning: connector-list shapes, the `connect create` stdout, and the
 * connector detail response. No subprocesses or I/O — just shape validation —
 * so the provisioning orchestrator ({@link import("./slackbot.js")}) stays
 * focused on flow and these stay trivially testable.
 */

import { z } from "zod";

interface VercelConnectListClient {
  uid?: unknown;
  id?: unknown;
  type?: unknown;
  createdAt?: unknown;
  projects?: unknown;
}

export interface VercelConnectListResponse {
  /** `vercel connect list -F json` (current CLI). */
  connectors?: unknown;
  /** Older CLI builds emitted the same array under `clients`. */
  clients?: unknown;
}

const NonEmptyStringSchema = z.string().min(1);

const SlackConnectorRefSchema = z.object({
  uid: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
});

const SlackConnectorDetailsSchema = SlackConnectorRefSchema.extend({
  data: z
    .object({
      appId: NonEmptyStringSchema.nullish(),
      slackTeam: z
        .object({
          id: NonEmptyStringSchema,
          name: NonEmptyStringSchema.nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/** Identifiers returned by Vercel Connect for a Slack connector. */
export type SlackConnectorRef = z.infer<typeof SlackConnectorRefSchema>;

/** Slack workspace metadata exposed by a connected Slack connector. */
export interface SlackWorkspaceConnection {
  workspaceUrl: string;
  workspaceName?: string;
}

/** Parsed Slack connector state returned by Vercel's connector detail API. */
export interface SlackConnectorDetails {
  ref: SlackConnectorRef;
  workspace?: SlackWorkspaceConnection;
}

/**
 * Parses the exact connector response. Vercel reports a completed Slack
 * workspace connection in `data.slackTeam`; its installations collection can
 * remain empty even after browser setup succeeds.
 */
export function parseSlackConnectorDetails(body: unknown): SlackConnectorDetails | undefined {
  const parsed = SlackConnectorDetailsSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const { id, uid, data } = parsed.data;
  const ref = { id, uid };
  if (data?.appId == null || data.slackTeam == null) return { ref };

  const workspaceUrl = new URL("https://slack.com/app_redirect");
  workspaceUrl.searchParams.set("app", data.appId);
  workspaceUrl.searchParams.set("team", data.slackTeam.id);
  const workspace =
    data.slackTeam.name == null
      ? { workspaceUrl: workspaceUrl.href }
      : { workspaceUrl: workspaceUrl.href, workspaceName: data.slackTeam.name };
  return {
    ref,
    workspace,
  };
}

/**
 * Reads the connector identifiers from `vercel connect create … -F json`
 * stdout, the authoritative source for the just-created connector's UID.
 * Returns `undefined` when stdout is empty or not the expected JSON.
 */
export function parseCreatedSlackConnector(stdout: string): SlackConnectorRef | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return parseSlackConnectorDetails(parsed)?.ref;
}

/**
 * Finds the expected connector, or the newest Slack connector already attached to this project.
 */
export function pickSlackConnector(
  listJson: unknown,
  projectId: string | undefined,
  expectedUid: string | undefined,
): SlackConnectorRef | undefined {
  if (projectId === undefined) return undefined;
  if (typeof listJson !== "object" || listJson === null) return undefined;
  const response = listJson as VercelConnectListResponse;
  const connectors = response.connectors ?? response.clients;
  if (!Array.isArray(connectors)) return undefined;

  let matched: { ref: SlackConnectorRef; createdAt: number } | undefined;
  for (const raw of connectors as VercelConnectListClient[]) {
    if (raw.type !== "slack") continue;
    if (typeof raw.uid !== "string" || typeof raw.id !== "string") continue;
    if (!Array.isArray(raw.projects)) continue;
    const matchesProject = raw.projects.some(
      (project) =>
        typeof project === "object" &&
        project !== null &&
        (project as { id?: unknown }).id === projectId,
    );
    if (!matchesProject) continue;

    const ref: SlackConnectorRef = { uid: raw.uid, id: raw.id };
    if (expectedUid !== undefined && ref.uid === expectedUid) {
      return ref;
    }
    const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : 0;
    if (!matched || createdAt > matched.createdAt) {
      matched = { ref, createdAt };
    }
  }
  return matched?.ref;
}

/**
 * Turns a Slack `app_redirect` install URL into a deep link that opens the
 * Messages tab, a DM compose with the bot, instead of the app's about page.
 * Slack honors `tab=messages` only on `app_redirect` links, the ones carrying
 * `app` and `team` ids; any other URL is returned unchanged.
 * See https://docs.slack.dev/interactivity/deep-linking/.
 */
export function slackMessageDeepLink(url: string): string {
  const parsed = URL.parse(url);
  if (
    parsed === null ||
    !parsed.pathname.endsWith("/app_redirect") ||
    !parsed.searchParams.has("app") ||
    !parsed.searchParams.has("team")
  ) {
    return url;
  }
  parsed.searchParams.set("tab", "messages");
  return parsed.href;
}

/** A Slack connector plus the project ids it is attached to. */
export interface RawSlackConnector {
  uid: string;
  projectIds: readonly string[];
}

/** Parses Slack connectors (uid + attached project ids) from a connect-list response. */
export function parseSlackConnectors(listJson: unknown): RawSlackConnector[] {
  if (typeof listJson !== "object" || listJson === null) return [];
  const response = listJson as VercelConnectListResponse;
  const connectors = response.connectors ?? response.clients;
  if (!Array.isArray(connectors)) return [];
  const parsed: RawSlackConnector[] = [];
  for (const raw of connectors as VercelConnectListClient[]) {
    if (raw.type !== "slack" || typeof raw.uid !== "string") continue;
    const projectIds = Array.isArray(raw.projects)
      ? raw.projects
          .map((project) =>
            typeof project === "object" && project !== null
              ? (project as { id?: unknown }).id
              : undefined,
          )
          .filter((id): id is string => typeof id === "string")
      : [];
    parsed.push({ uid: raw.uid, projectIds });
  }
  return parsed;
}
