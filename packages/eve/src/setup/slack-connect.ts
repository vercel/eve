/**
 * Pure parsers for Vercel Connect CLI/API payloads used by Slackbot
 * provisioning: connector-list shapes, the `connect create` stdout, and the
 * connector detail response. No subprocesses or I/O — just shape validation —
 * so the provisioning orchestrator ({@link import("./slackbot.js")}) stays
 * focused on flow and these stay trivially testable.
 */

import { z } from "#compiled/zod/index.js";

const NonEmptyStringSchema = z.string().min(1);

const SlackConnectorRefSchema = z.object({
  uid: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
});

const SlackTriggerDestinationSchema = z.object({
  projectId: NonEmptyStringSchema,
  path: NonEmptyStringSchema.nullish(),
  branch: NonEmptyStringSchema.nullish(),
  customEnvironmentId: NonEmptyStringSchema.nullish(),
});

const SlackConnectorDetailsSchema = SlackConnectorRefSchema.extend({
  triggerDestinations: z.array(SlackTriggerDestinationSchema).nullish(),
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

/**
 * One place Vercel Connect forwards Slack events. A destination without
 * `branch` or `customEnvironmentId` targets the project's default deployment.
 */
export interface SlackTriggerDestination {
  projectId: string;
  path?: string;
  branch?: string;
  customEnvironmentId?: string;
}

/** Parsed Slack connector state returned by Vercel's connector detail API. */
export interface SlackConnectorDetails {
  ref: SlackConnectorRef;
  workspace?: SlackWorkspaceConnection;
  triggerDestinations: readonly SlackTriggerDestination[];
}

function toTriggerDestination(
  raw: z.infer<typeof SlackTriggerDestinationSchema>,
): SlackTriggerDestination {
  const destination: SlackTriggerDestination = { projectId: raw.projectId };
  if (raw.path != null) destination.path = raw.path;
  if (raw.branch != null) destination.branch = raw.branch;
  if (raw.customEnvironmentId != null) destination.customEnvironmentId = raw.customEnvironmentId;
  return destination;
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
  const triggerDestinations = (parsed.data.triggerDestinations ?? []).map(toTriggerDestination);
  if (data?.appId == null || data.slackTeam == null) return { ref, triggerDestinations };

  const workspaceUrl = new URL("https://slack.com/app_redirect");
  workspaceUrl.searchParams.set("app", data.appId);
  workspaceUrl.searchParams.set("team", data.slackTeam.id);
  const workspace =
    data.slackTeam.name == null
      ? { workspaceUrl: workspaceUrl.href }
      : { workspaceUrl: workspaceUrl.href, workspaceName: data.slackTeam.name };
  return { ref, workspace, triggerDestinations };
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

/** A project attached to a connector. */
export interface SlackConnectorProject {
  id: string;
  name?: string;
}

/** A Slack connector plus the projects it is attached to. */
export interface RawSlackConnector {
  uid: string;
  id: string;
  /** Attached projects, possibly truncated to the first few. */
  projects: readonly SlackConnectorProject[];
  createdAt: number;
}

const ProjectLinkSchema = z.object({
  projectId: NonEmptyStringSchema,
  project: z.object({ id: NonEmptyStringSchema, name: z.string().nullish() }).nullish(),
});

const PaginationSchema = z.object({ next: z.string().nullish() }).nullish();

const ConnectorPageSchema = z.object({
  clients: z.array(
    z.object({
      id: NonEmptyStringSchema,
      uid: NonEmptyStringSchema,
      type: z.string(),
      createdAt: z.number().nullish(),
      includes: z
        .object({
          projects: z.object({ items: z.array(ProjectLinkSchema) }).nullish(),
        })
        .nullish(),
    }),
  ),
  pagination: PaginationSchema,
});

const ConnectorProjectsSchema = z.object({ projects: z.array(ProjectLinkSchema) });

function toProject(link: z.infer<typeof ProjectLinkSchema>): SlackConnectorProject {
  const id = link.project?.id ?? link.projectId;
  const name = link.project?.name;
  return name == null ? { id } : { id, name };
}

/** One page of `GET /v1/connect/connectors?include=projects`. */
export interface SlackConnectorPage {
  connectors: RawSlackConnector[];
  /** Cursor for the next page, absent on the last one. */
  next?: string;
}

/** Parses one connector list page, keeping only Slack connectors. */
export function parseSlackConnectorPage(body: unknown): SlackConnectorPage | undefined {
  const parsed = ConnectorPageSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const connectors = parsed.data.clients
    .filter((client) => client.type === "slack")
    .map((client) => ({
      uid: client.uid,
      id: client.id,
      projects: (client.includes?.projects?.items ?? []).map(toProject),
      createdAt: client.createdAt ?? 0,
    }));
  const next = parsed.data.pagination?.next;
  return next == null ? { connectors } : { connectors, next };
}

/** Parses one page of `GET /v1/connect/connectors/<id>/projects`. */
export function parseConnectorProjects(body: unknown): SlackConnectorProject[] | undefined {
  const parsed = ConnectorProjectsSchema.safeParse(body);
  return parsed.success ? parsed.data.projects.map(toProject) : undefined;
}
