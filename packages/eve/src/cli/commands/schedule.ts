import { Client } from "#client/index.js";
import {
  formatAuth,
  renderFetches,
  renderTurnPreviewInstructions,
  renderTurnPreviewRows,
} from "#cli/commands/turn-preview-rows.js";
import { createCliTheme, renderCliSection, type CliRow } from "#cli/ui/output.js";
import type { DevelopmentServer, DevelopmentServerOptions } from "#internal/nitro/host/types.js";
import { createEveDevDispatchSchedulePath } from "#protocol/routes.js";
import { dryRunSchedule, UnknownScheduleError } from "#services/schedule-dry-run.js";

interface ScheduleCommandLogger {
  log(message: string): void;
}

export interface ScheduleRunOptions {
  readonly as?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly payload?: string;
}

export interface ScheduleRunJson {
  readonly schedule: string;
  readonly sessionIds: readonly string[];
  readonly url: string;
}

type StartHost = (appRoot: string, options?: DevelopmentServerOptions) => DevelopmentServer;

export async function runScheduleRunCommand(
  logger: ScheduleCommandLogger,
  appRoot: string,
  schedule: string,
  options: ScheduleRunOptions,
  startHost?: StartHost,
): Promise<void> {
  if (options.dryRun === true) {
    const { parsePreviewPrincipal } = await import("#services/turn-preview.js");
    const result = await dryRunSchedule({
      appRoot,
      payload: options.payload === undefined ? undefined : parsePayload(options.payload),
      principal: options.as === undefined ? undefined : parsePreviewPrincipal(options.as),
      schedule,
    });
    logger.log(options.json === true ? JSON.stringify(result, null, 2) : renderDryRun(result));
    if (result.error !== null) process.exitCode = 1;
    return;
  }
  if (options.payload !== undefined || options.as !== undefined) {
    throw new Error(
      "--payload and --as need --dry-run. A real run fires a dynamic schedule from what it stored, through its client's invoke().",
    );
  }

  const create =
    startHost ?? (await import("#cli/dev/local-server-process.js")).createDevelopmentServer;
  const server = create(appRoot, { existing: "attach-if-unconfigured", output: "stderr" });
  try {
    const handle = await server.start();
    const client = new Client({ baseUrl: handle.url });
    const response = await client.fetch(createEveDevDispatchSchedulePath(schedule), {
      method: "POST",
    });
    const body = (await response.json()) as {
      readonly availableScheduleIds?: readonly string[];
      readonly error?: string;
      readonly sessionIds?: readonly string[];
    };
    if (response.status === 404 && body.availableScheduleIds !== undefined) {
      const dynamic = await dynamicScheduleNames(handle.appRoot);
      if (dynamic.includes(schedule)) {
        throw new Error(
          `"${schedule}" is a dynamic schedule (defineDynamicSchedules), which fires from the schedules users and the agent create. Fire a stored one with invoke() from schedules(definition), or preview a run with --dry-run --payload '<json>' --as <creator>.`,
        );
      }
      throw new UnknownScheduleError(schedule, [...body.availableScheduleIds, ...dynamic]);
    }
    if (!response.ok) {
      throw new Error(
        `Schedule dispatch failed with ${response.status}: ${body.error ?? response.statusText}`,
      );
    }
    const result: ScheduleRunJson = {
      schedule,
      sessionIds: body.sessionIds ?? [],
      url: handle.url,
    };
    logger.log(
      options.json === true
        ? JSON.stringify(result, null, 2)
        : renderCliSection(createCliTheme(), {
            rows: [
              { label: "Server", value: handle.url },
              {
                label: "Sessions",
                value: result.sessionIds.length === 0 ? "none" : result.sessionIds.join("\n"),
              },
            ],
            title: `Schedule ${schedule}`,
          }),
    );
    if (handle.kind === "started") {
      await Promise.all(result.sessionIds.map((id) => untilSettled(client, id)));
    }
  } finally {
    await server.close();
  }
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(
      `--payload must be JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function dynamicScheduleNames(appRoot: string): Promise<string[]> {
  const [{ loadCompiledManifest }, { createDiskRuntimeCompiledArtifactsSource }] =
    await Promise.all([
      import("#runtime/loaders/manifest.js"),
      import("#runtime/compiled-artifacts-source.js"),
    ]);
  const manifest = await loadCompiledManifest({
    compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
  });
  return (manifest.scheduleCollections ?? []).map((collection) => collection.name);
}

async function untilSettled(client: Client, sessionId: string): Promise<void> {
  for await (const event of client.sessions.attach(sessionId).stream()) {
    if (
      event.type === "turn.settled" ||
      event.type === "turn.paused" ||
      event.type === "session.ended"
    ) {
      return;
    }
  }
}

function renderDryRun(result: Awaited<ReturnType<typeof dryRunSchedule>>): string {
  const theme = createCliTheme();
  const summary: CliRow[] = [
    {
      label: "Mode",
      value: "dry run: no sessions started, no model calls, fetch answered locally",
    },
    {
      label: "Deliveries",
      tone: result.deliveries.length === 0 ? "warning" : "default",
      value: String(result.deliveries.length),
    },
    ...(result.creator === null
      ? []
      : [
          {
            label: "Creator",
            value: `${result.creator.principal.type} ${result.creator.principal.principalId} (authenticator ${result.creator.principal.authenticator})`,
          },
          {
            label: "Creator Auth",
            tone: result.creator.auth === null ? ("danger" as const) : ("default" as const),
            value:
              result.creator.auth === null
                ? "not resolved; the run didn't start"
                : `${formatAuth(result.creator.auth)}, as auth() resolved it`,
          },
        ]),
    ...(result.controls.length === 0
      ? []
      : [{ label: "Schedule Calls", value: result.controls.join(", ") }]),
    ...(result.error === null
      ? []
      : [{ label: "Error", tone: "danger" as const, value: result.error }]),
  ];
  const sections = [
    renderCliSection(theme, { rows: summary, title: `Schedule ${result.schedule}` }),
  ];
  result.deliveries.forEach((delivery, index) => {
    const rows: CliRow[] = [
      { label: "Target", value: JSON.stringify(delivery.target) ?? "none" },
      { label: "Message", value: formatMessage(delivery.message) },
      ...renderTurnPreviewRows(delivery.turn).map((row) =>
        row.label === "Auth" ? { ...row, value: formatAuth(delivery.auth) } : row,
      ),
    ];
    sections.push(
      renderCliSection(theme, {
        rows,
        title: `Delivery ${index + 1} to ${delivery.channel}`,
      }),
      renderCliSection(theme, {
        rows: [
          { label: "Instructions", value: renderTurnPreviewInstructions(delivery.turn) || "none" },
        ],
        title: `Delivery ${index + 1} instructions`,
      }),
    );
  });
  sections.push(renderFetches(result.fetches));
  return sections.join("\n\n");
}

function formatMessage(message: unknown): string {
  if (message === null) return "none";
  return typeof message === "string" ? message : JSON.stringify(message, null, 2);
}
