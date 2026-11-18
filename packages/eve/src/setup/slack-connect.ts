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

export type SlackConnectorRef = z.infer<typeof SlackConnectorRefSchema>;

export interface SlackWorkspaceConnection {
  workspaceUrl: string;
  workspaceName?: string;
}

export interface SlackTriggerDestination {
  projectId: string;
  path?: string;
  branch?: string;
  customEnvironmentId?: string;
}

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

export interface SlackConnectorProject {
  id: string;
  name?: string;
}

export interface RawSlackConnector {
  uid: string;
  id: string;
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

export interface SlackConnectorPage {
  connectors: RawSlackConnector[];
  next?: string;
}

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

export function parseConnectorProjects(body: unknown): SlackConnectorProject[] | undefined {
  const parsed = ConnectorProjectsSchema.safeParse(body);
  return parsed.success ? parsed.data.projects.map(toProject) : undefined;
}
