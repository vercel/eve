import { type ApplicationInspection, inspectApplication } from "#services/inspect-application.js";
import { type CliRow, createCliTheme, renderCliBanner, renderCliSection } from "#cli/ui/output.js";

interface CliInfoLogger {
  log(message: string): void;
}

/** Options accepted by {@link printApplicationInfo}. */
export interface PrintApplicationInfoOptions {
  /** Emit a machine-readable JSON document instead of the human table. */
  json?: boolean;
}

/** Machine-readable view of an application inspection, emitted by `eve info --json`. */
export interface ApplicationInfoJson {
  appRoot: string;
  agentRoot: string | null;
  layout: string | null;
  status: string;
  diagnostics: { errors: number; warnings: number } | null;
  model: string | null;
  instructions: string | null;
  skills: string[];
  tools: string[];
  channels: { name: string; kind: string | null; method: string | null; urlPath: string | null }[];
  messaging: { create: string; continue: string; stream: string };
  artifacts: {
    compiledManifest: string;
    discoveryManifest: string;
    diagnostics: string;
    moduleMap: string;
    metadata: string;
  } | null;
}

/**
 * Projects a structured inspection into the stable `eve info --json` contract.
 * Tools and channels an agent relies on to verify setup come straight from the
 * compiled manifest, so this stays in sync with what the runtime actually serves.
 */
export function buildApplicationInfoJson(inspection: ApplicationInspection): ApplicationInfoJson {
  const { application: info, compiledState, messaging } = inspection;
  return {
    appRoot: info.appRoot,
    agentRoot: compiledState?.project.agentRoot ?? null,
    layout: compiledState?.project.layout ?? null,
    status: compiledState?.metadata.status ?? "unavailable",
    diagnostics: compiledState
      ? {
          errors: compiledState.metadata.discovery.summary.errors,
          warnings: compiledState.metadata.discovery.summary.warnings,
        }
      : null,
    model: compiledState?.manifest.config.model.id ?? null,
    instructions: compiledState?.manifest.instructions?.logicalPath ?? null,
    skills: (compiledState?.manifest.skills ?? []).map((skill) => skill.name),
    tools: (compiledState?.manifest.tools ?? []).map((tool) => tool.name),
    channels: (compiledState?.manifest.channels ?? []).map((channel) =>
      channel.kind === "channel"
        ? {
            name: channel.name,
            kind: channel.adapterKind ?? null,
            method: channel.method,
            urlPath: channel.urlPath,
          }
        : { name: channel.name, kind: "disabled", method: null, urlPath: null },
    ),
    messaging: {
      create: messaging.createSessionRoutePath,
      continue: messaging.continueSessionRoutePattern,
      stream: messaging.streamRoutePattern,
    },
    artifacts: compiledState
      ? {
          compiledManifest: compiledState.paths.compiledManifestPath,
          discoveryManifest: compiledState.paths.discoveryManifestPath,
          diagnostics: compiledState.paths.diagnosticsPath,
          moduleMap: compiledState.paths.moduleMapPath,
          metadata: compiledState.paths.compileMetadataPath,
        }
      : null,
  };
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatDiscoverySummary(errors: number, warnings: number): string {
  return `${pluralize(errors, "error")}, ${pluralize(warnings, "warning")}`;
}

function resolveCompileTone(status: string): "danger" | "success" | "warning" {
  switch (status) {
    case "ready":
      return "success";
    case "failed":
      return "danger";
    default:
      return "warning";
  }
}

/**
 * Writes resolved application details and the active message-route contract.
 */
export async function printApplicationInfo(
  logger: CliInfoLogger,
  appRoot: string,
  options: PrintApplicationInfoOptions = {},
): Promise<void> {
  const inspection = await inspectApplication(appRoot);

  if (options.json) {
    logger.log(JSON.stringify(buildApplicationInfoJson(inspection), null, 2));
    return;
  }

  const compiledState = inspection.compiledState;
  const info = inspection.application;
  const theme = createCliTheme();
  const applicationRows: CliRow[] = [
    {
      label: "App Root",
      value: info.appRoot,
    },
  ];
  const artifactRows: CliRow[] = [
    {
      label: "Workflow Build",
      value: info.workflowBuildDir,
    },
    {
      label: "Output",
      value: info.outputDir,
    },
  ];
  const instructionsRows: CliRow[] = [];

  if (compiledState !== null) {
    applicationRows.push(
      {
        label: "Agent Root",
        value: compiledState.project.agentRoot,
      },
      {
        label: "Layout",
        value: compiledState.project.layout,
      },
      {
        label: "Compile",
        tone: resolveCompileTone(compiledState.metadata.status),
        value: compiledState.metadata.status,
      },
      {
        label: "Diagnostics",
        tone:
          compiledState.metadata.discovery.summary.errors > 0
            ? "danger"
            : compiledState.metadata.discovery.summary.warnings > 0
              ? "warning"
              : "success",
        value: formatDiscoverySummary(
          compiledState.metadata.discovery.summary.errors,
          compiledState.metadata.discovery.summary.warnings,
        ),
      },
      {
        label: "Instructions",
        value: compiledState.manifest.instructions?.logicalPath ?? "none",
      },
      {
        label: "Skills",
        value: pluralize(compiledState.manifest.skills.length, "skill"),
      },
    );
    artifactRows.unshift(
      {
        label: "Compiled Manifest",
        value: compiledState.paths.compiledManifestPath,
      },
      {
        label: "Discovery Manifest",
        value: compiledState.paths.discoveryManifestPath,
      },
      {
        label: "Diagnostics",
        value: compiledState.paths.diagnosticsPath,
      },
      {
        label: "Module Map",
        value: compiledState.paths.moduleMapPath,
      },
      {
        label: "Metadata",
        value: compiledState.paths.compileMetadataPath,
      },
    );
    instructionsRows.push(
      compiledState.manifest.instructions === undefined
        ? {
            label: "Instructions",
            value: "No instructions prompt discovered.",
          }
        : {
            label: "Instructions",
            value: compiledState.manifest.instructions.logicalPath,
          },
    );
  } else {
    applicationRows.push({
      label: "Compile",
      tone: "warning",
      value: "unavailable",
    });
  }

  logger.log(
    [
      renderCliBanner(theme, {
        subtitle: "Resolved application paths and the active message contract.",
        title: "eve Info",
      }),
      "",
      renderCliSection(theme, {
        rows: applicationRows,
        title: "Application",
      }),
      "",
      renderCliSection(theme, {
        rows: artifactRows,
        title: "Artifacts",
      }),
      ...(compiledState === null
        ? []
        : [
            "",
            renderCliSection(theme, {
              rows: instructionsRows,
              title: "Instructions",
            }),
          ]),
      "",
      renderCliSection(theme, {
        rows: [
          {
            label: "Workflow ID",
            value: info.workflowId,
          },
          {
            label: "Source Dir",
            value: info.workflowSourceDir,
          },
          {
            label: "Create",
            tone: "info",
            value: `POST ${inspection.messaging.createSessionRoutePath}`,
          },
          {
            label: "Continue",
            tone: "info",
            value: `POST ${inspection.messaging.continueSessionRoutePattern}`,
          },
          {
            label: "Stream",
            tone: "info",
            value: `GET ${inspection.messaging.streamRoutePattern}`,
          },
        ],
        title: "Messaging",
      }),
    ].join("\n"),
  );
}
