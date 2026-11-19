import { Client } from "#client/index.js";
import {
  formatAuth,
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
  readonly dryRun?: boolean;
  readonly json?: boolean;
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
    const result = await dryRunSchedule({ appRoot, schedule });
    logger.log(options.json === true ? JSON.stringify(result, null, 2) : renderDryRun(result));
    if (result.error !== null) process.exitCode = 1;
    return;
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
      throw new UnknownScheduleError(schedule, body.availableScheduleIds);
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
  sections.push(
    renderCliSection(theme, {
      rows: [
        {
          label: "Fetches",
          value:
            result.fetches.length === 0
              ? "none"
              : result.fetches.map((request) => `${request.method} ${request.url}`).join("\n"),
        },
      ],
      title: "Network (answered with {} instead of sent)",
    }),
  );
  return sections.join("\n\n");
}

function formatMessage(message: unknown): string {
  if (message === null) return "none";
  return typeof message === "string" ? message : JSON.stringify(message, null, 2);
}
